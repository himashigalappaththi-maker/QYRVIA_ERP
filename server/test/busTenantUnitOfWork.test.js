'use strict';

/**
 * Phase 64 — command/query bus wiring of the tenant unit of work.
 *
 * The contracts asserted here:
 *   - a tenantScoped command runs inside ONE tenant-bound transaction;
 *   - a handler that REJECTS (returns ok:false) rolls back — it must not
 *     commit whatever it wrote before deciding to reject;
 *   - domain events publish only AFTER commit, never for a rolled-back command;
 *   - a tenantScoped query runs READ ONLY;
 *   - with no unit of work configured, production FAILS CLOSED.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');

const T1 = '11111111-1111-1111-1111-111111111111';
const CTX = { tenantId: T1, propertyId: 'p-1', requestId: 'r-1', actorId: 'a-1' };

/** Records what the bus asked the unit of work to do. */
function fakeUow() {
  const calls = { write: [], read: [], committed: 0, rolledBack: 0 };
  return {
    calls,
    pool: { connect: async () => ({}) },
    async runWithTenantTransaction(pool, tenantId, cb) {
      calls.write.push(tenantId);
      try { const r = await cb({ query: async () => ({ rows: [] }) }, { tenantId, mode: 'write' }); calls.committed += 1; return r; }
      catch (e) { calls.rolledBack += 1; throw e; }
    },
    async runWithTenantRead(pool, tenantId, cb) {
      calls.read.push(tenantId);
      return cb({ query: async () => ({ rows: [] }) }, { tenantId, mode: 'read' });
    }
  };
}

function silentEventBus(collector) {
  eventBus.init({ db: {
    async insertAuditEvent() {},
    async insertDomainEvent(ev) { if (collector) collector.push(ev.event_type); }
  } });
}

function domainEvent(type) {
  return {
    event_id: 'e-' + Math.random().toString(36).slice(2),
    event_type: type, aggregate_type: 'reservation', aggregate_id: 'RES-1',
    tenant_id: T1, property_id: 'p-1', actor_id: 'a-1', request_id: 'r-1',
    payload: {}, occurred_at: new Date().toISOString()
  };
}

beforeEach(() => { commandBus.reset(); queryBus.reset(); eventBus.reset(); delete process.env.NODE_ENV_OVERRIDE; });
afterEach(()  => { commandBus.reset(); queryBus.reset(); eventBus.reset(); });

// ---------------------------------------------------------------------------
// Command bus
// ---------------------------------------------------------------------------

test('a tenantScoped command runs inside a tenant-bound write transaction', async () => {
  silentEventBus();
  const uow = fakeUow();
  commandBus.setUnitOfWork(uow);
  commandBus.register({
    name: 'pms.reservation.create', aggregateType: 'reservation',
    tenantScoped: true, transactionMode: 'write',
    async handler() { return { ok: true, result: { id: 'RES-1' } }; }
  });

  const r = await commandBus.dispatch('pms.reservation.create', {}, CTX);

  assert.equal(r.ok, true);
  assert.deepEqual(uow.calls.write, [T1], 'exactly one write unit, bound to the ctx tenant');
  assert.equal(uow.calls.committed, 1);
  assert.equal(uow.calls.rolledBack, 0);
});

test('a command WITHOUT tenantScoped does not open a unit of work', async () => {
  silentEventBus();
  const uow = fakeUow();
  commandBus.setUnitOfWork(uow);
  commandBus.register({
    name: 'auth.user.create', aggregateType: 'user',
    async handler() { return { ok: true, result: {} }; }
  });

  await commandBus.dispatch('auth.user.create', {}, CTX);
  assert.deepEqual(uow.calls.write, [], 'non-tenant-scoped commands are untouched');
});

test('a handler returning ok:false ROLLS BACK — a rejected command leaves nothing behind', async () => {
  silentEventBus();
  const uow = fakeUow();
  commandBus.setUnitOfWork(uow);
  commandBus.register({
    name: 'pms.reservation.checkin', aggregateType: 'reservation', tenantScoped: true,
    async handler() {
      // Imagine rows written here before the guard fails.
      return { ok: false, error: 'invalid_transition', detail: 'from CHECKED_OUT' };
    }
  });

  const r = await commandBus.dispatch('pms.reservation.checkin', {}, CTX);

  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_transition', 'the rejection reason must survive the rollback');
  assert.equal(r.detail, 'from CHECKED_OUT');
  assert.equal(uow.calls.rolledBack, 1, 'ok:false must roll the transaction back');
  assert.equal(uow.calls.committed, 0, 'a rejected command must never commit');
});

test('a throwing handler rolls back and is reported as handler_threw', async () => {
  silentEventBus();
  const uow = fakeUow();
  commandBus.setUnitOfWork(uow);
  commandBus.register({
    name: 'pms.folio.charge.post', aggregateType: 'folio', tenantScoped: true,
    async handler() { throw new Error('rollup exploded'); }
  });

  const r = await commandBus.dispatch('pms.folio.charge.post', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'handler_threw');
  assert.match(r.detail, /rollup exploded/);
  assert.equal(uow.calls.rolledBack, 1);
});

test('domain events publish only AFTER commit', async () => {
  const published = [];
  silentEventBus(published);
  const order = [];
  const uow = {
    pool: { connect: async () => ({}) },
    async runWithTenantTransaction(pool, tenantId, cb) {
      const r = await cb({ query: async () => ({ rows: [] }) }, { tenantId, mode: 'write' });
      order.push('COMMIT');
      return r;
    },
    async runWithTenantRead(pool, tenantId, cb) { return cb({}, {}); }
  };
  commandBus.setUnitOfWork(uow);
  eventBus.subscribe('reservation.created', async () => { order.push('EVENT'); });

  commandBus.register({
    name: 'pms.reservation.create', aggregateType: 'reservation', tenantScoped: true,
    async handler() { return { ok: true, result: {}, events: [domainEvent('reservation.created')] }; }
  });

  await commandBus.dispatch('pms.reservation.create', {}, CTX);
  assert.deepEqual(order, ['COMMIT', 'EVENT'], 'the event must not precede the commit');
  assert.deepEqual(published, ['reservation.created']);
});

test('NO domain event is published for a rolled-back command', async () => {
  const published = [];
  silentEventBus(published);
  const uow = fakeUow();
  commandBus.setUnitOfWork(uow);

  commandBus.register({
    name: 'pms.reservation.checkin', aggregateType: 'reservation', tenantScoped: true,
    async handler() {
      return { ok: false, error: 'folio_open_failed', events: [domainEvent('reservation.checked_in')] };
    }
  });

  const r = await commandBus.dispatch('pms.reservation.checkin', {}, CTX);
  assert.equal(r.ok, false);
  assert.deepEqual(published, [],
    'announcing a check-in that a rollback erased is worse than losing the announcement');
});

test('a TENANT_ error from the unit of work is reported as tenant_context_failed, never as success', async () => {
  silentEventBus();
  commandBus.setUnitOfWork({
    pool: { connect: async () => ({}) },
    async runWithTenantTransaction() {
      const e = new Error('bind failed'); e.code = 'TENANT_BIND_FAILED'; throw e;
    },
    async runWithTenantRead() { return null; }
  });
  commandBus.register({
    name: 'pms.reservation.create', aggregateType: 'reservation', tenantScoped: true,
    async handler() { return { ok: true, result: {} }; }
  });

  const r = await commandBus.dispatch('pms.reservation.create', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'tenant_context_failed');
  assert.equal(r.detail, 'TENANT_BIND_FAILED');
});

test('PRODUCTION with no unit of work REFUSES a tenant-scoped command (no unbound fallback)', async () => {
  silentEventBus();
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    let handlerRan = false;
    commandBus.register({
      name: 'pms.reservation.create', aggregateType: 'reservation', tenantScoped: true,
      async handler() { handlerRan = true; return { ok: true, result: {} }; }
    });
    const r = await commandBus.dispatch('pms.reservation.create', {}, CTX);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'tenant_unit_of_work_unavailable');
    assert.equal(handlerRan, false, 'the handler must not run against an unbound connection');
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
  }
});

test('outside production, no unit of work still runs the handler (in-memory test repos)', async () => {
  silentEventBus();
  commandBus.register({
    name: 'pms.reservation.create', aggregateType: 'reservation', tenantScoped: true,
    async handler() { return { ok: true, result: { id: 'RES-1' } }; }
  });
  const r = await commandBus.dispatch('pms.reservation.create', {}, CTX);
  assert.equal(r.ok, true, 'in-memory repositories have no pool and no RLS');
});

test('setUnitOfWork validates its argument and reset() clears it', () => {
  assert.throws(() => commandBus.setUnitOfWork({ pool: {} }), /required/);
  assert.equal(commandBus.hasUnitOfWork(), false);
  commandBus.setUnitOfWork(fakeUow());
  assert.equal(commandBus.hasUnitOfWork(), true);
  commandBus.reset();
  assert.equal(commandBus.hasUnitOfWork(), false, 'no leakage between tests');
});

// ---------------------------------------------------------------------------
// Query bus
// ---------------------------------------------------------------------------

test('a tenantScoped query runs inside a tenant-bound READ ONLY unit', async () => {
  const uow = fakeUow();
  queryBus.setUnitOfWork(uow);
  queryBus.register({
    name: 'pms.reservation.list', resourceType: 'reservation', tenantScoped: true,
    async handler() { return { ok: true, data: [] }; }
  });

  const r = await queryBus.execute('pms.reservation.list', {}, CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(uow.calls.read, [T1]);
  assert.deepEqual(uow.calls.write, [], 'a query must never open a write transaction');
});

test('a query WITHOUT tenantScoped does not open a unit of work', async () => {
  const uow = fakeUow();
  queryBus.setUnitOfWork(uow);
  queryBus.register({
    name: 'platform.health', resourceType: 'platform',
    async handler() { return { ok: true, data: {} }; }
  });
  await queryBus.execute('platform.health', {}, CTX);
  assert.deepEqual(uow.calls.read, []);
});

test('PRODUCTION with no unit of work REFUSES a tenant-scoped query', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    let ran = false;
    queryBus.register({
      name: 'pms.reservation.list', resourceType: 'reservation', tenantScoped: true,
      async handler() { ran = true; return { ok: true, data: [] }; }
    });
    const r = await queryBus.execute('pms.reservation.list', {}, CTX);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'tenant_unit_of_work_unavailable');
    assert.equal(ran, false);
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
  }
});

test('a TENANT_ error from a query unit is reported, not swallowed', async () => {
  queryBus.setUnitOfWork({
    pool: { connect: async () => ({}) },
    async runWithTenantRead() {
      const e = new Error('no context'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
    }
  });
  queryBus.register({
    name: 'pms.folio.byId', resourceType: 'folio', tenantScoped: true,
    async handler() { return { ok: true, data: {} }; }
  });
  const r = await queryBus.execute('pms.folio.byId', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'tenant_context_failed');
});
