'use strict';

/**
 * Phase 63 P1-1 — a domain-event persistence failure must never be silent.
 *
 * The state change is already committed when publish() fails, so the command
 * outcome legitimately stays ok=true. What must NOT happen is the failure
 * disappearing: it has to reach the injected failure hook (wired to
 * metrics/alerting at boot) and be attached to the outcome for downstream
 * detection — WITHOUT changing the serialised response shape.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');

const CTX = { tenantId: 't-1', propertyId: 'p-1', requestId: 'r-1', actorId: 'a-1' };

function domainEvent(type) {
  return {
    event_id: 'e-' + Math.random().toString(36).slice(2),
    event_type: type,
    aggregate_type: 'reservation',
    aggregate_id: 'RES-1',
    tenant_id: CTX.tenantId,
    property_id: CTX.propertyId,
    actor_id: CTX.actorId,
    request_id: CTX.requestId,
    payload: {},
    occurred_at: new Date().toISOString()
  };
}

beforeEach(() => { commandBus.reset(); eventBus.reset(); });
afterEach(()  => { commandBus.reset(); eventBus.reset(); });

test('publish failure fires the failure hook with the command and event types', async () => {
  eventBus.init({ db: {
    async insertAuditEvent() {},
    async insertDomainEvent() { throw new Error('event_store_down'); }
  } });

  const seen = [];
  commandBus.setEventPersistenceFailureHook((info) => seen.push(info));

  commandBus.register({
    name: 'reservation.create',
    aggregateType: 'reservation',
    handler: async () => ({ ok: true, result: { id: 'RES-1' }, events: [domainEvent('reservation.created')] })
  });

  const out = await commandBus.dispatch('reservation.create', {}, CTX);

  assert.equal(out.ok, true, 'the state change happened, so the command still reports success');
  assert.equal(seen.length, 1, 'the failure hook must fire exactly once per dispatch');
  assert.equal(seen[0].command, 'reservation.create');
  assert.deepEqual(seen[0].failures.map(f => f.event_type), ['reservation.created']);
});

test('the outcome carries a non-enumerable degradation marker (response shape unchanged)', async () => {
  eventBus.init({ db: {
    async insertAuditEvent() {},
    async insertDomainEvent() { throw new Error('event_store_down'); }
  } });

  commandBus.register({
    name: 'reservation.create',
    aggregateType: 'reservation',
    handler: async () => ({ ok: true, result: { id: 'RES-1' }, events: [domainEvent('reservation.created')] })
  });

  const out = await commandBus.dispatch('reservation.create', {}, CTX);

  assert.ok(Array.isArray(out.eventPersistenceFailures), 'marker is readable by downstream code');
  assert.equal(out.eventPersistenceFailures.length, 1);
  assert.ok(!Object.keys(out).includes('eventPersistenceFailures'),
    'marker must be non-enumerable so JSON responses and deepEqual assertions are unaffected');
  assert.equal(JSON.stringify(out).includes('eventPersistenceFailures'), false);
});

test('every failing event in a multi-event command is reported, not just the first', async () => {
  eventBus.init({ db: {
    async insertAuditEvent() {},
    async insertDomainEvent() { throw new Error('event_store_down'); }
  } });

  const seen = [];
  commandBus.setEventPersistenceFailureHook((info) => seen.push(info));

  commandBus.register({
    name: 'pms.checkin',
    aggregateType: 'reservation',
    handler: async () => ({
      ok: true,
      result: {},
      events: [domainEvent('reservation.checked_in'), domainEvent('room.status_changed')]
    })
  });

  await commandBus.dispatch('pms.checkin', {}, CTX);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].failures.map(f => f.event_type),
    ['reservation.checked_in', 'room.status_changed']);
});

test('the happy path fires no hook and sets no marker', async () => {
  const stored = [];
  eventBus.init({ db: {
    async insertAuditEvent() {},
    async insertDomainEvent(ev) { stored.push(ev); }
  } });

  let hookCalls = 0;
  commandBus.setEventPersistenceFailureHook(() => { hookCalls += 1; });

  commandBus.register({
    name: 'reservation.create',
    aggregateType: 'reservation',
    handler: async () => ({ ok: true, result: {}, events: [domainEvent('reservation.created')] })
  });

  const out = await commandBus.dispatch('reservation.create', {}, CTX);

  assert.equal(out.ok, true);
  assert.equal(hookCalls, 0);
  assert.equal(out.eventPersistenceFailures, undefined);
  assert.equal(stored.length, 1);
});

test('a throwing failure hook cannot break the dispatch', async () => {
  eventBus.init({ db: {
    async insertAuditEvent() {},
    async insertDomainEvent() { throw new Error('event_store_down'); }
  } });

  commandBus.setEventPersistenceFailureHook(() => { throw new Error('alerting_down'); });
  commandBus.register({
    name: 'reservation.create',
    aggregateType: 'reservation',
    handler: async () => ({ ok: true, result: { id: 'RES-1' }, events: [domainEvent('reservation.created')] })
  });

  const out = await commandBus.dispatch('reservation.create', {}, CTX);
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { id: 'RES-1' });
});

test('reset() clears the hook so tests cannot leak into each other', async () => {
  let calls = 0;
  commandBus.setEventPersistenceFailureHook(() => { calls += 1; });
  commandBus.reset();

  eventBus.init({ db: {
    async insertAuditEvent() {},
    async insertDomainEvent() { throw new Error('event_store_down'); }
  } });
  commandBus.register({
    name: 'reservation.create',
    aggregateType: 'reservation',
    handler: async () => ({ ok: true, result: {}, events: [domainEvent('reservation.created')] })
  });

  await commandBus.dispatch('reservation.create', {}, CTX);
  assert.equal(calls, 0);
});
