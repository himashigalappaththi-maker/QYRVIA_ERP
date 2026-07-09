'use strict';

/**
 * Phase 52 D5 — Quote handler tests.
 * Tests GET /api/booking/quote via direct handler invocation (no HTTP server).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildQuoteHandler } = require('../src/booking-engine/api/bookingHandlers');
const { build }             = require('../src/booking-engine/api/booking.routes');

// ---- helpers ----------------------------------------------------------------

function fakeRes() {
  return {
    _status: 200, _json: null,
    status(s) { this._status = s; return this; },
    json(b)   { this._json = b;   return this; }
  };
}

function fakeReq({ ctx = {}, query = {} } = {}) {
  return { ctx, query, body: {}, params: {} };
}

function fakeAriService({ bookable = true, total = 400, los = 2, available = 5, currency = 'USD', nights = [], reasons = [] } = {}) {
  return {
    async quoteStay() {
      if (!bookable) return { bookable: false, reasons };
      return { bookable: true, total, los, available, currency, nights, reasons: [] };
    }
  };
}

// ---- Tests ------------------------------------------------------------------

test('GET /booking/quote: bookable result -> 200 with data', async () => {
  const handler = buildQuoteHandler({ ariService: fakeAriService({ bookable: true, total: 400, los: 2, available: 5 }) });
  const res = fakeRes();
  await handler(fakeReq({ ctx: { tenantId: 't1', propertyId: 'p1' }, query: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', rate_plan_id: 'rp1' } }), res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.bookable, true);
  assert.equal(res._json.data.total, 400);
  assert.equal(res._json.data.los, 2);
  assert.equal(res._json.data.available, 5);
  assert.deepEqual(res._json.data.reasons, []);
});

test('GET /booking/quote: non-bookable -> 400 with reasons[]', async () => {
  const handler = buildQuoteHandler({ ariService: fakeAriService({ bookable: false, reasons: ['no_availability'] }) });
  const res = fakeRes();
  await handler(fakeReq({ ctx: { tenantId: 't1', propertyId: 'p1' }, query: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', rate_plan_id: 'rp1' } }), res, () => {});
  assert.equal(res._status, 400);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'not_bookable');
  assert.ok(Array.isArray(res._json.reasons));
  assert.ok(res._json.reasons.includes('no_availability'));
});

test('GET /booking/quote: missing room_type_id -> 400 missing_required_params', async () => {
  const handler = buildQuoteHandler({ ariService: fakeAriService() });
  const res = fakeRes();
  await handler(fakeReq({ ctx: { tenantId: 't1', propertyId: 'p1' }, query: { arrival: '2026-08-01', departure: '2026-08-03' } }), res, () => {});
  assert.equal(res._status, 400);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'missing_required_params');
  assert.ok(Array.isArray(res._json.required));
  assert.ok(res._json.required.includes('room_type_id'));
});

test('GET /booking/quote: missing arrival -> 400 missing_required_params', async () => {
  const handler = buildQuoteHandler({ ariService: fakeAriService() });
  const res = fakeRes();
  await handler(fakeReq({ ctx: { tenantId: 't1', propertyId: 'p1' }, query: { room_type_id: 'rt1', departure: '2026-08-03' } }), res, () => {});
  assert.equal(res._status, 400);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'missing_required_params');
});

test('GET /booking/quote: missing tenant context -> 401 tenant_required', async () => {
  const handler = buildQuoteHandler({ ariService: fakeAriService() });
  const res = fakeRes();
  await handler(fakeReq({ ctx: {}, query: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03' } }), res, () => {});
  assert.equal(res._status, 401);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'tenant_required');
});

test('GET /booking/quote: no ariService injected -> 200 ari_not_configured', async () => {
  const handler = buildQuoteHandler(); // no ariService
  const res = fakeRes();
  await handler(fakeReq({ ctx: { tenantId: 't1', propertyId: 'p1' }, query: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03' } }), res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.bookable, false);
  assert.equal(res._json.data.reason, 'ari_not_configured');
});

test('GET /booking/quote: ariService throws -> 500 quote_failed', async () => {
  const brokenService = { async quoteStay() { throw new Error('db_connection_lost'); } };
  const handler = buildQuoteHandler({ ariService: brokenService });
  const res = fakeRes();
  await handler(fakeReq({ ctx: { tenantId: 't1', propertyId: 'p1' }, query: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', rate_plan_id: 'rp1' } }), res, () => {});
  assert.equal(res._status, 500);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'quote_failed');
  assert.ok(res._json.message.includes('db_connection_lost'));
});
