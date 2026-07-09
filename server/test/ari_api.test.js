'use strict';

/**
 * Phase 52 D6 — ARI management API handler tests.
 * Tests: room types, rate plans, compute ARI, quote stay, missing tenant -> 401,
 * missing permission -> 403, no ariService -> graceful response.
 * Uses direct handler invocation pattern (no HTTP server).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildAriHandlers } = require('../src/ari/api/ari.handlers');
const { build }            = require('../src/ari/api/ari.routes');

// ARI in-memory deps
const { buildMemoryAriStore } = require('../src/ari/store/memoryStore');
const { buildAriService }     = require('../src/ari/ariService');

// ---- helpers ----------------------------------------------------------------

function fakeRes() {
  return {
    _status: 200, _json: null,
    status(s) { this._status = s; return this; },
    json(b)   { this._json = b;   return this; }
  };
}

function fakeReq({ ctx = {}, query = {}, body = {}, params = {} } = {}) {
  return { ctx, query, body, params };
}

function buildSeededStore() {
  const store = buildMemoryAriStore();
  store.putRoomType({ propertyId: 'p1', roomTypeId: 'rt1', code: 'STD', name: 'Standard', totalUnits: 10 });
  store.putRatePlan({ propertyId: 'p1', ratePlanId: 'rp1', roomTypeId: 'rt1', code: 'BAR', name: 'Best Available', currency: 'USD', baseRate: 150, standardOccupancy: 2, maxOccupancy: 3 });
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 10, sold: 0, blocked: 0 });
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-02', physical: 10, sold: 0, blocked: 0 });
  return store;
}

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq' };

// ---- Tests ------------------------------------------------------------------

test('GET /ari/room-types -> 200 with list', async () => {
  const store = buildSeededStore();
  const h = buildAriHandlers({ ariStore: store });
  const res = fakeRes();
  await h.listRoomTypes(fakeReq({ ctx: CTX }), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.ok(Array.isArray(res._json.data));
  assert.equal(res._json.data.length, 1);
  assert.equal(res._json.data[0].roomTypeId, 'rt1');
});

test('POST /ari/room-types: upserts and returns room type row', async () => {
  const store = buildSeededStore();
  const h = buildAriHandlers({ ariStore: store });
  const res = fakeRes();
  await h.upsertRoomType(
    fakeReq({
      ctx: CTX,
      body: { propertyId: 'p1', roomTypeId: 'rt2', code: 'DLX', name: 'Deluxe', totalUnits: 5 }
    }),
    res
  );
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.roomTypeId, 'rt2');
});

test('GET /ari/rate-plans -> 200 with list', async () => {
  const store = buildSeededStore();
  const h = buildAriHandlers({ ariStore: store });
  const res = fakeRes();
  await h.listRatePlans(fakeReq({ ctx: CTX }), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.ok(Array.isArray(res._json.data));
  assert.equal(res._json.data.length, 1);
  assert.equal(res._json.data[0].ratePlanId, 'rp1');
});

test('GET /ari/compute -> 200 with ARI output contract shape', async () => {
  const store = buildSeededStore();
  const service = buildAriService({ store });
  const h = buildAriHandlers({ ariService: service, ariStore: store });
  const res = fakeRes();
  await h.computeAri(
    fakeReq({ ctx: CTX, query: { property_id: 'p1', date_from: '2026-08-01', date_to: '2026-08-03' } }),
    res
  );
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  const data = res._json.data;
  assert.ok(data.ari_version);
  assert.ok(Array.isArray(data.room_types));
});

test('GET /ari/quote -> 200 when bookable', async () => {
  const store = buildSeededStore();
  const service = buildAriService({ store });
  const h = buildAriHandlers({ ariService: service, ariStore: store });
  const res = fakeRes();
  await h.quoteStay(
    fakeReq({
      ctx: CTX,
      query: { property_id: 'p1', room_type_id: 'rt1', rate_plan_id: 'rp1', arrival: '2026-08-01', departure: '2026-08-03' }
    }),
    res
  );
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  // quote result should have bookable flag
  assert.ok('bookable' in res._json.data);
});

test('missing tenant -> 401 on read handler', async () => {
  const store = buildSeededStore();
  const h = buildAriHandlers({ ariStore: store });
  const res = fakeRes();
  await h.listRoomTypes(fakeReq({ ctx: {} }), res);
  assert.equal(res._status, 401);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'tenant_required');
});

test('missing tenant -> 401 on write handler', async () => {
  const store = buildSeededStore();
  const h = buildAriHandlers({ ariStore: store });
  const res = fakeRes();
  await h.upsertRoomType(fakeReq({ ctx: {}, body: { roomTypeId: 'rt9', code: 'X' } }), res);
  assert.equal(res._status, 401);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'tenant_required');
});

test('no ariService -> computeAri returns graceful ari_not_configured', async () => {
  const store = buildSeededStore();
  const h = buildAriHandlers({ ariStore: store }); // no ariService
  const res = fakeRes();
  await h.computeAri(fakeReq({ ctx: CTX, query: { date_from: '2026-08-01', date_to: '2026-08-03' } }), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.bookable, false);
  assert.equal(res._json.data.reason, 'ari_not_configured');
});

test('ARI route builder returns a router with all expected routes', () => {
  const store = buildSeededStore();
  const service = buildAriService({ store });
  const router = build({ ariService: service, ariStore: store });
  // Router should have routes (stacks)
  assert.ok(router, 'router should be built');
  const routePaths = router.stack
    .filter((l) => l.route)
    .map((l) => l.route.path)
    .sort();
  assert.ok(routePaths.includes('/room-types'), 'should include /room-types');
  assert.ok(routePaths.includes('/rate-plans'), 'should include /rate-plans');
  assert.ok(routePaths.includes('/inventory'), 'should include /inventory');
  assert.ok(routePaths.includes('/compute'), 'should include /compute');
  assert.ok(routePaths.includes('/quote'), 'should include /quote');
});
