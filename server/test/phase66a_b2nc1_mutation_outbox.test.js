'use strict';

/**
 * Phase 66A-B2N-C1 — focused BEHAVIOURAL contract: an authoritative ARI
 * mutation and its ARI outbox event are produced inside ONE tenant-bound
 * transaction, committing together or rolling back together.
 *
 * Fake pools and fake transaction clients only — no PostgreSQL connection, no
 * network, no migration. The fake client records every statement so the tests
 * can prove the mutation and the enqueue ran on the SAME client between one
 * BEGIN and one COMMIT.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  withTenantAriUnit, withTenantAriStore,
  ARI_CONFIG_EFFECTIVE_FROM, ARI_CONFIG_EFFECTIVE_TO
} = require('../src/ari/store/tenantAriStore');
const { runWithTenantTransaction, ERR } = require('../src/db/tenantUnitOfWork');
const { buildAriInventoryAdjuster } = require('../src/booking-engine/ariInventoryAdjuster');
const { buildAriHandlers } = require('../src/ari/api/ari.handlers');
const { buildAriDedupeKey } = require('../src/ari/outbox/ariOutboxStore');

const TENANT_A  = '11111111-1111-4111-8111-111111111111';
const TENANT_B  = '22222222-2222-4222-8222-222222222222';
const PROPERTY  = '33333333-3333-4333-8333-333333333333';

// ---------------------------------------------------------------------------
// Fake pg-shaped pool. One client instance per connect(); every statement is
// recorded with the identity of the client that ran it.
// ---------------------------------------------------------------------------
function makeFakePool({ boundTenantId, failOn } = {}) {
  const state = { connects: 0, begins: 0, commits: 0, rollbacks: 0, statements: [] };
  let clientSeq = 0;

  function makeClient() {
    const clientId = ++clientSeq;
    return {
      clientId,
      async query(text, params) {
        const sql = String(text).trim();
        if (/^BEGIN/i.test(sql)) { state.begins += 1; return { rows: [] }; }
        if (/^COMMIT/i.test(sql)) { state.commits += 1; return { rows: [] }; }
        if (/^ROLLBACK/i.test(sql)) { state.rollbacks += 1; return { rows: [] }; }
        if (/set_config\('app\.tenant_id'/.test(sql)) return { rows: [] };
        if (/app_current_tenant\(\)/.test(sql)) return { rows: [{ tid: boundTenantId }] };

        const kind = /INSERT INTO ari_outbox_store/i.test(sql) ? 'outbox'
          : /SELECT \* FROM ari_outbox_store/i.test(sql) ? 'outbox_lookup'
            : 'ari';
        state.statements.push({ kind, clientId, sql, params });
        if (failOn && failOn(kind, state.statements.filter((s) => s.kind === kind).length)) {
          throw new Error('simulated_' + kind + '_failure');
        }
        return {
          rows: [{
            version: 7, sold: 3,
            property_id: PROPERTY, room_type_id: 'rt1', date: '2026-08-01',
            code: 'STD', name: 'Standard', total_units: 10, physical: 10, blocked: 0
          }]
        };
      },
      release() {}
    };
  }

  return { pool: { async connect() { state.connects += 1; return makeClient(); } }, state };
}

const outboxStatements = (state) => state.statements.filter((s) => s.kind === 'outbox');
const ariStatements    = (state) => state.statements.filter((s) => s.kind === 'ari');

// ---------------------------------------------------------------------------
// The combined unit
// ---------------------------------------------------------------------------

test('withTenantAriUnit: mutation and enqueue run on the SAME client inside ONE BEGIN/COMMIT', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await withTenantAriUnit(pool, TENANT_A, async ({ ariStore, outbox }) => {
    await ariStore.adjustSold({ tenant_id: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1', date: '2026-08-01', delta: 1 });
    await outbox.enqueue({
      tenantId: TENANT_A, propertyId: PROPERTY,
      eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
      roomTypeId: 'rt1', ratePlanId: null,
      effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
      sourceVersion: 7, payload: { date: '2026-08-01' }
    });
  });
  assert.equal(state.connects, 1);
  assert.equal(state.begins, 1);
  assert.equal(state.commits, 1);
  assert.equal(state.rollbacks, 0);
  const clients = new Set(state.statements.map((s) => s.clientId));
  assert.equal(clients.size, 1, 'mutation and enqueue shared one client');
});

test('withTenantAriUnit: an enqueue failure produces ONE ROLLBACK and NO COMMIT', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A, failOn: (kind) => kind === 'outbox' });
  await assert.rejects(() => withTenantAriUnit(pool, TENANT_A, async ({ ariStore, outbox }) => {
    await ariStore.adjustSold({ tenant_id: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1', date: '2026-08-01', delta: 1 });
    await outbox.enqueue({
      tenantId: TENANT_A, propertyId: PROPERTY,
      eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
      roomTypeId: 'rt1', ratePlanId: null,
      effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
      sourceVersion: 7, payload: {}
    });
  }));
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(ariStatements(state).length, 1, 'the mutation ran but was rolled back');
});

test('withTenantAriUnit: a mutation failure rolls back and never reaches the enqueue', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A, failOn: (kind) => kind === 'ari' });
  await assert.rejects(() => withTenantAriUnit(pool, TENANT_A, async ({ ariStore, outbox }) => {
    await ariStore.adjustSold({ tenant_id: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1', date: '2026-08-01', delta: 1 });
    await outbox.enqueue({ tenantId: TENANT_A, propertyId: PROPERTY, eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY', roomTypeId: 'rt1', ratePlanId: null, effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 7, payload: {} });
  }));
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(outboxStatements(state).length, 0, 'no enqueue occurred');
});

test('withTenantAriUnit: a nested same-tenant unit reuses the one client — no second connect or BEGIN', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await runWithTenantTransaction(pool, TENANT_A, async () => {
    await withTenantAriUnit(pool, TENANT_A, ({ ariStore }) =>
      ariStore.adjustSold({ tenant_id: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1', date: '2026-08-01', delta: 1 }));
    await withTenantAriUnit(pool, TENANT_A, ({ outbox }) =>
      outbox.enqueue({ tenantId: TENANT_A, propertyId: PROPERTY, eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY', roomTypeId: 'rt1', ratePlanId: null, effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 7, payload: {} }));
  });
  assert.equal(state.connects, 1);
  assert.equal(state.begins, 1);
  assert.equal(state.commits, 1);
  assert.equal(new Set(state.statements.map((s) => s.clientId)).size, 1);
});

test('withTenantAriUnit: cross-tenant composition fails closed with TENANT_CONTEXT_MISMATCH and issues no SQL', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(
    () => runWithTenantTransaction(pool, TENANT_A, () => withTenantAriUnit(pool, TENANT_B, () => {})),
    (err) => err.code === ERR.TENANT_CONTEXT_MISMATCH
  );
  assert.equal(state.statements.length, 0);
});

test('withTenantAriStore hands callers a store carrying the same-client outbox', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await withTenantAriStore(pool, TENANT_A, async (ariStore) => {
    assert.equal(typeof ariStore.outbox.enqueue, 'function');
    await ariStore.adjustSold({ tenant_id: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1', date: '2026-08-01', delta: 1 });
    await ariStore.outbox.enqueue({ tenantId: TENANT_A, propertyId: PROPERTY, eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY', roomTypeId: 'rt1', ratePlanId: null, effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 7, payload: {} });
  });
  assert.equal(new Set(state.statements.map((s) => s.clientId)).size, 1);
  assert.equal(state.begins, 1);
  assert.equal(state.commits, 1);
});

// ---------------------------------------------------------------------------
// Multi-night adjuster
// ---------------------------------------------------------------------------

function realAdjuster(pool) {
  return buildAriInventoryAdjuster({
    withAriStore: (tenantId, cb) => withTenantAriStore(pool, tenantId, cb)
  });
}

test('adjuster: a 3-night adjustment performs 3 mutations and 3 enqueues in ONE transaction', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await realAdjuster(pool).adjustSold({
    tenantId: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-04', delta: 1
  });
  assert.equal(state.connects, 1);
  assert.equal(state.begins, 1);
  assert.equal(state.commits, 1);
  assert.equal(ariStatements(state).length, 3);
  assert.equal(outboxStatements(state).length, 3);
  assert.equal(new Set(state.statements.map((s) => s.clientId)).size, 1);
});

test('adjuster: each night emits its own night as the half-open effective period, with the DB-returned version', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await realAdjuster(pool).adjustSold({
    tenantId: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03', delta: 1
  });
  const rows = outboxStatements(state).map((s) => s.params);
  // INSERT column order: tenant, property, event_type, resource_kind,
  // room_type_id, rate_plan_id, effective_from, effective_to, source_version…
  assert.deepEqual(rows.map((p) => p[6]), ['2026-08-01', '2026-08-02']);
  assert.deepEqual(rows.map((p) => p[7]), ['2026-08-02', '2026-08-03']);
  assert.ok(rows.every((p) => p[2] === 'INVENTORY_CHANGED' && p[3] === 'INVENTORY'));
  assert.ok(rows.every((p) => p[5] === null), 'ratePlanId is null for inventory events');
  assert.ok(rows.every((p) => p[8] === 7), 'sourceVersion is the version the database returned');
});

test('adjuster: a failure on the middle night rolls back the WHOLE adjustment and stops later work', async () => {
  const { pool, state } = makeFakePool({
    boundTenantId: TENANT_A,
    failOn: (kind, nth) => kind === 'outbox' && nth === 2
  });
  await assert.rejects(() => realAdjuster(pool).adjustSold({
    tenantId: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-04', delta: 1
  }));
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(ariStatements(state).length, 2, 'the third night never ran');
});

test('adjuster: an enqueue error is never swallowed — it propagates to the caller', async () => {
  const { pool } = makeFakePool({ boundTenantId: TENANT_A, failOn: (kind) => kind === 'outbox' });
  await assert.rejects(
    () => realAdjuster(pool).adjustSold({
      tenantId: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1',
      arrival: '2026-08-01', departure: '2026-08-02', delta: 1
    }),
    /simulated_outbox_failure/
  );
});

test('adjuster: a floor/ceiling-guarded night emits no event and does not abort the unit', async () => {
  const calls = [];
  const fakeStore = {
    async adjustSold(args) { calls.push(args.date); return args.date === '2026-08-02' ? null : { sold: 1, version: 4 }; },
    outbox: { enqueued: [], async enqueue(e) { this.enqueued.push(e); return { accepted: true }; } }
  };
  const adjuster = buildAriInventoryAdjuster({ withAriStore: (t, cb) => cb(fakeStore) });
  await adjuster.adjustSold({
    tenantId: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-04', delta: -1
  });
  assert.equal(calls.length, 3, 'all three nights were attempted');
  assert.equal(fakeStore.outbox.enqueued.length, 2, 'only the two changed nights emitted');
  assert.ok(!fakeStore.outbox.enqueued.some((e) => e.effectiveFrom === '2026-08-02'));
});

test('adjuster: a missing propertyId fails BEFORE any mutation', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(
    () => realAdjuster(pool).adjustSold({
      tenantId: TENANT_A, propertyId: null, roomTypeId: 'rt1',
      arrival: '2026-08-01', departure: '2026-08-02', delta: 1
    }),
    /propertyId is required/
  );
  assert.equal(state.connects, 0, 'no connection was even taken');
});

test('adjuster: an ARI unit without an outbox refuses to let a mutation commit alone', async () => {
  const fakeStore = { async adjustSold() { return { sold: 1, version: 2 }; } };
  const adjuster = buildAriInventoryAdjuster({ withAriStore: (t, cb) => cb(fakeStore) });
  await assert.rejects(
    () => adjuster.adjustSold({
      tenantId: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1',
      arrival: '2026-08-01', departure: '2026-08-02', delta: 1
    }),
    /exposes no outbox/
  );
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    _status: 200, _json: null,
    status(s) { this._status = s; return this; },
    json(b) { this._json = b; return this; }
  };
}
function unitSeam() {
  const enqueued = [];
  const saved = [];
  const ariStore = {
    async putRoomType(f) { saved.push(f); return { roomTypeId: f.roomTypeId, code: f.code, name: f.name, totalUnits: f.totalUnits, version: 11 }; },
    async putRatePlan(f) { saved.push(f); return { roomTypeId: f.roomTypeId, ratePlanId: f.ratePlanId, code: f.code, currency: f.currency, baseRate: f.baseRate, version: 12 }; },
    async putInventoryCell(f) { saved.push(f); return { roomTypeId: f.roomTypeId, date: f.date, physical: f.physical, sold: f.sold, blocked: f.blocked, overbookingBuffer: 0, stopSell: false, version: 13 }; },
    async putRestrictionRule(f) { saved.push(f); return { id: f.id, version: 14 }; },
    async adjustSold(f) { saved.push(f); return f.date === 'GUARD' ? null : { sold: 5, version: 15 }; },
    async updateInventoryOptimistic() { return { conflict: true, updated: 0 }; }
  };
  const withAriUnit = (tenantId, cb) => cb({
    ariStore,
    outbox: { async enqueue(e) { enqueued.push(e); return { accepted: true, deduped: false, row: {} }; } }
  });
  return { withAriUnit, enqueued, saved };
}
const CTX = { tenantId: TENANT_A, propertyId: PROPERTY, requestId: 'rq' };

test('handler putRoomType: emits AVAILABILITY_CHANGED with the DB version over the sentinel window', async () => {
  const seam = unitSeam();
  const h = buildAriHandlers({ withAriUnit: seam.withAriUnit });
  const res = fakeRes();
  await h.upsertRoomType({ ctx: CTX, body: { roomTypeId: 'rt1', code: 'STD', name: 'Standard', totalUnits: 10 } }, res);
  assert.equal(res._status, 200);
  assert.equal(seam.enqueued.length, 1);
  const e = seam.enqueued[0];
  assert.equal(e.eventType, 'AVAILABILITY_CHANGED');
  assert.equal(e.resourceKind, 'AVAILABILITY');
  assert.equal(e.ratePlanId, null);
  assert.equal(e.sourceVersion, 11);
  assert.equal(e.effectiveFrom, ARI_CONFIG_EFFECTIVE_FROM);
  assert.equal(e.effectiveTo, ARI_CONFIG_EFFECTIVE_TO);
  assert.equal(res._json.data.version, 11, 'version is returned additively');
});

test('handler putRatePlan: emits RATE_CHANGED carrying the rate plan and the DB version', async () => {
  const seam = unitSeam();
  const h = buildAriHandlers({ withAriUnit: seam.withAriUnit });
  const res = fakeRes();
  await h.upsertRatePlan({ ctx: CTX, body: { ratePlanId: 'rp1', roomTypeId: 'rt1', code: 'BAR', currency: 'USD', baseRate: 100 } }, res);
  assert.equal(res._status, 200);
  assert.equal(seam.enqueued.length, 1);
  assert.equal(seam.enqueued[0].eventType, 'RATE_CHANGED');
  assert.equal(seam.enqueued[0].resourceKind, 'RATE');
  assert.equal(seam.enqueued[0].ratePlanId, 'rp1');
  assert.equal(seam.enqueued[0].sourceVersion, 12);
});

test('handler putInventoryCell: emits exactly one INVENTORY_CHANGED for the cell date', async () => {
  const seam = unitSeam();
  const h = buildAriHandlers({ withAriUnit: seam.withAriUnit });
  const res = fakeRes();
  await h.upsertInventoryCell({ ctx: CTX, body: { roomTypeId: 'rt1', date: '2026-08-01', physical: 10, sold: 0, blocked: 2, stopSell: true } }, res);
  assert.equal(res._status, 200);
  assert.equal(seam.enqueued.length, 1, 'one event even though blocked/stopSell changed too');
  assert.equal(seam.enqueued[0].eventType, 'INVENTORY_CHANGED');
  assert.equal(seam.enqueued[0].effectiveFrom, '2026-08-01');
  assert.equal(seam.enqueued[0].effectiveTo, '2026-08-02');
  assert.equal(seam.enqueued[0].sourceVersion, 13);
});

test('handler adjustSold: emits on a real change and emits NOTHING on a floor guard', async () => {
  const seam = unitSeam();
  const h = buildAriHandlers({ withAriUnit: seam.withAriUnit });

  const okRes = fakeRes();
  await h.adjustSold({ ctx: CTX, body: { roomTypeId: 'rt1', date: '2026-08-01', delta: 1 } }, okRes);
  assert.equal(okRes._json.data.adjusted, true);
  assert.equal(seam.enqueued.length, 1);
  assert.equal(seam.enqueued[0].sourceVersion, 15);

  const guardRes = fakeRes();
  await h.adjustSold({ ctx: CTX, body: { roomTypeId: 'rt1', date: 'GUARD', delta: -1 } }, guardRes);
  assert.equal(guardRes._json.data.adjusted, false);
  assert.equal(guardRes._json.data.reason, 'floor_guard');
  assert.equal(seam.enqueued.length, 1, 'the guarded adjustment emitted no event');
});

test('handler putRestrictionRule: returns the version additively but emits NO event (B2N-C2 deferral)', async () => {
  const seam = unitSeam();
  const h = buildAriHandlers({ withAriUnit: seam.withAriUnit });
  const res = fakeRes();
  await h.upsertRestrictionRule({ ctx: CTX, body: { id: 'r1', level: 'property', date_from: '2026-08-01', date_to: '2026-08-31' } }, res);
  assert.equal(res._status, 200);
  assert.equal(res._json.data.version, 14);
  assert.equal(seam.enqueued.length, 0);
});

test('handlers fail closed with property_required — before mutating — when no property can be resolved', async () => {
  const seam = unitSeam();
  const h = buildAriHandlers({ withAriUnit: seam.withAriUnit });
  const ctxNoProperty = { tenantId: TENANT_A, requestId: 'rq' };
  for (const [name, body] of [
    ['upsertRoomType', { roomTypeId: 'rt1', code: 'STD' }],
    ['upsertRatePlan', { ratePlanId: 'rp1', roomTypeId: 'rt1', code: 'BAR' }],
    ['upsertInventoryCell', { roomTypeId: 'rt1', date: '2026-08-01' }],
    ['adjustSold', { roomTypeId: 'rt1', date: '2026-08-01', delta: 1 }]
  ]) {
    const res = fakeRes();
    await h[name]({ ctx: ctxNoProperty, body }, res);
    assert.equal(res._status, 400, name + ' rejects a missing property');
    assert.equal(res._json.error, 'property_required');
  }
  assert.equal(seam.saved.length, 0, 'no mutation was attempted');
  assert.equal(seam.enqueued.length, 0);
});

test('handlers still reject a missing tenant with 401 before anything else', async () => {
  const seam = unitSeam();
  const h = buildAriHandlers({ withAriUnit: seam.withAriUnit });
  const res = fakeRes();
  await h.upsertRoomType({ ctx: {}, body: { roomTypeId: 'rt1', code: 'STD' } }, res);
  assert.equal(res._status, 401);
  assert.equal(res._json.error, 'tenant_required');
  assert.equal(seam.saved.length, 0);
});

// ---------------------------------------------------------------------------
// Canonical identity and payload guards (through the real store)
// ---------------------------------------------------------------------------

test('an invalid sourceVersion fails before any outbox SQL', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(() => withTenantAriUnit(pool, TENANT_A, ({ outbox }) => outbox.enqueue({
    tenantId: TENANT_A, propertyId: PROPERTY, eventType: 'INVENTORY_CHANGED',
    resourceKind: 'INVENTORY', roomTypeId: 'rt1', ratePlanId: null,
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    sourceVersion: null, payload: {}
  })), /sourceVersion must be a positive integer/);
  assert.equal(outboxStatements(state).length, 0);
});

test('a secret-like payload key is still rejected before any outbox SQL', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(() => withTenantAriUnit(pool, TENANT_A, ({ outbox }) => outbox.enqueue({
    tenantId: TENANT_A, propertyId: PROPERTY, eventType: 'INVENTORY_CHANGED',
    resourceKind: 'INVENTORY', roomTypeId: 'rt1', ratePlanId: null,
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    sourceVersion: 1, payload: { nested: { apiKey: 'x' } }
  })), /must not contain secret material/);
  assert.equal(outboxStatements(state).length, 0);
});

test('the emitted identities are the canonical B2N-B keys — config window vs dated night, and rate-plan-sensitive', () => {
  const roomType = buildAriDedupeKey({
    eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY', roomTypeId: 'rt1',
    ratePlanId: null, effectiveFrom: ARI_CONFIG_EFFECTIVE_FROM, effectiveTo: ARI_CONFIG_EFFECTIVE_TO, sourceVersion: 1
  });
  const night = buildAriDedupeKey({
    eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY', roomTypeId: 'rt1',
    ratePlanId: null, effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 1
  });
  const ratePlanA = buildAriDedupeKey({
    eventType: 'RATE_CHANGED', resourceKind: 'RATE', roomTypeId: 'rt1',
    ratePlanId: 'rp1', effectiveFrom: ARI_CONFIG_EFFECTIVE_FROM, effectiveTo: ARI_CONFIG_EFFECTIVE_TO, sourceVersion: 1
  });
  const ratePlanB = buildAriDedupeKey({
    eventType: 'RATE_CHANGED', resourceKind: 'RATE', roomTypeId: 'rt1',
    ratePlanId: 'rp2', effectiveFrom: ARI_CONFIG_EFFECTIVE_FROM, effectiveTo: ARI_CONFIG_EFFECTIVE_TO, sourceVersion: 1
  });
  for (const k of [roomType, night, ratePlanA, ratePlanB]) assert.match(k, /^aob:v1:[0-9a-f]{64}$/);
  assert.notEqual(roomType, night);
  assert.notEqual(ratePlanA, ratePlanB, 'rate-plan identity affects the rate event key');
});

test('a later authoritative version produces a distinct event identity', () => {
  const base = { eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY', roomTypeId: 'rt1', ratePlanId: null, effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02' };
  assert.notEqual(
    buildAriDedupeKey(Object.assign({}, base, { sourceVersion: 7 })),
    buildAriDedupeKey(Object.assign({}, base, { sourceVersion: 8 }))
  );
});

test('no channel_sync_queue_store statement and no reservation_id parameter is ever issued', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await realAdjuster(pool).adjustSold({
    tenantId: TENANT_A, propertyId: PROPERTY, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03', delta: 1
  });
  for (const s of state.statements) {
    assert.ok(!/channel_sync_queue_store/i.test(s.sql));
    assert.ok(!/reservation_id/i.test(s.sql));
  }
});
