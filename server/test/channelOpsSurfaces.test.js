'use strict';

/**
 * Phase 37 WI-3 - channel operational surfaces controller/route tests.
 *
 * Exercises GET /sync-health, GET /dlq and POST /dlq/reprocess through the HTTP
 * controller (handlers built directly with injected doubles, mirroring
 * channelTestConnectionRoute.test.js). Asserts the READ/write envelopes,
 * fail-closed tenant handling, tenant isolation, the cross-tenant reprocess
 * guard, and that NO payload/secret data leaks into responses.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildController } = require('../src/channel-manager/api/channel.controller');
const { build } = require('../src/channel-manager/api/channel.routes');
const { buildDeadLetterStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

const CTX_T1 = { tenantId: 't1', propertyId: 'p1', requestId: 'rq1' };
const CTX_T2 = { tenantId: 't2', propertyId: 'p2', requestId: 'rq2' };
const CTX_NO_TENANT = { requestId: 'rqx' };

const SECRET = 'SUPER_SECRET_API_KEY_should_never_appear';

function fakeRes() {
  return { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
}

function fakeCM() {
  return {
    status() {
      return {
        channels: [{ channel: 'QYRVIA_CONNECT', qyrvia_owned: true, commissionPct: 0 }],
        queue: { size: 3, deadLetter: 1 },
        bookings: 7
      };
    }
  };
}

// Seed a dead-letter store with realistic records across two tenants.
function seededDLQ() {
  const dlq = buildDeadLetterStoreMemory();
  const a = dlq.insert({ tenant_id: 't1', reservation_id: 'res-1', action: 'push_inventory', channel: 'QYRVIA_CONNECT', last_error: 'timeout', payload_json: { api_key: SECRET, rate: 100 } });
  const b = dlq.insert({ tenant_id: 't1', reservation_id: 'res-2', action: 'push_rates', channel: 'QYRVIA_CONNECT', last_error: 'http_500', payload_json: { secret: SECRET } });
  const c = dlq.insert({ tenant_id: 't2', reservation_id: 'res-9', action: 'confirm_booking', channel: 'EXPEDIA', last_error: 'boom', payload_json: { token: SECRET } });
  return { dlq, ids: { t1a: a.item.id, t1b: b.item.id, t2c: c.item.id } };
}

// ---- sync-health -----------------------------------------------------------

test('sync-health: ready => 200 with channels/queue/bookings and tenant-scoped dead-letter count', async () => {
  const { dlq } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  await c.syncHealth({ ctx: CTX_T1, body: {} }, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.ok(Array.isArray(res._json.data.channels));
  assert.equal(res._json.data.channels[0].channel, 'QYRVIA_CONNECT');
  assert.deepEqual(res._json.data.queue, { size: 3, deadLetter: 1 });
  assert.equal(res._json.data.bookings, 7);
  assert.equal(res._json.data.deadLetters.tenantCount, 2, 't1 owns two dead letters');
  assert.equal(res._json.requestId, 'rq1');
  assert.ok(!JSON.stringify(res._json).includes(SECRET), 'no payload/secret leakage');
});

test('sync-health: tenantCount reflects the other tenant only', async () => {
  const { dlq } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  await c.syncHealth({ ctx: CTX_T2, body: {} }, res, () => {});
  assert.equal(res._json.data.deadLetters.tenantCount, 1, 't2 owns one dead letter');
});

test('sync-health: no dead-letter store => tenantCount null', async () => {
  const c = buildController({ channelManager: fakeCM() });
  const res = fakeRes();
  await c.syncHealth({ ctx: CTX_T1, body: {} }, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.data.deadLetters.tenantCount, null);
});

test('sync-health: missing tenant fails closed => 401 tenant_required', async () => {
  const { dlq } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  await c.syncHealth({ ctx: CTX_NO_TENANT, body: {} }, res, () => {});
  assert.equal(res._status, 401);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'tenant_required');
});

// ---- dlq list --------------------------------------------------------------

test('dlq list: returns only current tenant items, metadata-only, no payload_json', async () => {
  const { dlq } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  await c.dlqList({ ctx: CTX_T1, body: {} }, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.items.length, 2);
  for (const it of res._json.data.items) {
    assert.equal(it.reservation_id.startsWith('res-') && it.reservation_id !== 'res-9', true, 'only t1 rows');
    assert.equal('payload_json' in it, false, 'payload_json must be excluded');
    assert.deepEqual(Object.keys(it).sort(), ['action', 'attempts', 'channel', 'created_at', 'id', 'last_error', 'reprocess_requested', 'reservation_id', 'updated_at']);
  }
  assert.ok(!JSON.stringify(res._json).includes(SECRET), 'no payload/secret leakage');
});

test('dlq list: no dead-letter store wired => 200 empty items', async () => {
  const c = buildController({ channelManager: fakeCM() });
  const res = fakeRes();
  await c.dlqList({ ctx: CTX_T1, body: {} }, res, () => {});
  assert.equal(res._status, 200);
  assert.deepEqual(res._json.data, { items: [] });
});

test('dlq list: missing tenant fails closed => 401 tenant_required', async () => {
  const { dlq } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  await c.dlqList({ ctx: CTX_NO_TENANT, body: {} }, res, () => {});
  assert.equal(res._status, 401);
  assert.equal(res._json.error, 'tenant_required');
});

// ---- dlq reprocess ---------------------------------------------------------

test('dlq reprocess: valid own id => 200 and record flagged', async () => {
  const { dlq, ids } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  await c.dlqReprocess({ ctx: CTX_T1, body: { id: ids.t1a } }, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.result.id, ids.t1a);
  assert.equal(res._json.result.reprocess_requested, true);
  assert.equal(dlq.get(ids.t1a).reprocess_requested, true, 'store record now flagged');
});

test('dlq reprocess: missing id => 400 id_required', async () => {
  const { dlq } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  await c.dlqReprocess({ ctx: CTX_T1, body: {} }, res, () => {});
  assert.equal(res._status, 400);
  assert.equal(res._json.error, 'id_required');
});

test('dlq reprocess: cross-tenant id => 404 dead_letter_not_found and NOT flagged', async () => {
  const { dlq, ids } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  // t1 tries to reprocess a record owned by t2.
  await c.dlqReprocess({ ctx: CTX_T1, body: { id: ids.t2c } }, res, () => {});
  assert.equal(res._status, 404);
  assert.equal(res._json.error, 'dead_letter_not_found');
  assert.equal(dlq.get(ids.t2c).reprocess_requested, false, 'cross-tenant record must NOT be flagged');
});

test('dlq reprocess: no dead-letter store => 400 dlq_unavailable', async () => {
  const c = buildController({ channelManager: fakeCM() });
  const res = fakeRes();
  await c.dlqReprocess({ ctx: CTX_T1, body: { id: 'anything' } }, res, () => {});
  assert.equal(res._status, 400);
  assert.equal(res._json.error, 'dlq_unavailable');
});

test('dlq reprocess: missing tenant fails closed => 401 tenant_required', async () => {
  const { dlq, ids } = seededDLQ();
  const c = buildController({ channelManager: fakeCM(), deadLetter: dlq });
  const res = fakeRes();
  await c.dlqReprocess({ ctx: CTX_NO_TENANT, body: { id: ids.t1a } }, res, () => {});
  assert.equal(res._status, 401);
  assert.equal(res._json.error, 'tenant_required');
  assert.equal(dlq.get(ids.t1a).reprocess_requested, false, 'no flagging without tenant context');
});

// ---- route registration ----------------------------------------------------

test('routes: /sync-health, /dlq and /dlq/reprocess are mounted', () => {
  const { dlq } = seededDLQ();
  const router = build({ channelManager: fakeCM(), channelPersistence: { deadLetter: dlq } });
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes('/sync-health'), 'GET /sync-health mounted');
  assert.ok(paths.includes('/dlq'), 'GET /dlq mounted');
  assert.ok(paths.includes('/dlq/reprocess'), 'POST /dlq/reprocess mounted');
});
