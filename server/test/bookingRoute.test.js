'use strict';

/** Phase 26 - Booking Engine HTTP handlers: create/update/cancel mapping to BookingService. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingHandlers } = require('../src/booking-engine/api/bookingHandlers');
const { build } = require('../src/booking-engine/api/booking.routes');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq' };

function fakeRes() {
  return { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
}
function fakeEngine(behavior = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async createBooking(body, ctx) { calls.push({ op: 'create', body, ctx }); return behavior.create || { ok: true, reservation_id: 'res-1', pricing: { total: 115 } }; },
      async updateBooking(body, ctx) { calls.push({ op: 'update', body, ctx }); return behavior.update || { ok: true, action: 'update', reservation_id: body.reservation_id }; },
      async cancelBooking(body, ctx) { calls.push({ op: 'cancel', body, ctx }); return behavior.cancel || { ok: true, action: 'cancel' }; }
    }
  };
}

test('create handler maps a successful booking to { ok, result }', async () => {
  const eng = fakeEngine();
  const h = buildBookingHandlers({ bookingEngine: eng });
  const res = fakeRes();
  await h.create({ ctx: CTX, body: { room_type_id: 'rt1' } }, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.result.reservation_id, 'res-1');
  assert.equal(res._json.result.pricing.total, 115);
  assert.equal(eng.calls[0].op, 'create');
});

test('create handler maps a rejection to 400 with reason/detail', async () => {
  const eng = fakeEngine({ create: { ok: false, reason: 'VALIDATION_FAILED', detail: ['adult_required'] } });
  const h = buildBookingHandlers({ bookingEngine: eng });
  const res = fakeRes();
  await h.create({ ctx: CTX, body: {} }, res, () => {});
  assert.equal(res._status, 400);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'VALIDATION_FAILED');
  assert.deepEqual(res._json.detail, ['adult_required']);
});

test('update/cancel handlers carry reservation_id from the path param', async () => {
  const eng = fakeEngine();
  const h = buildBookingHandlers({ bookingEngine: eng });
  const ru = fakeRes(); await h.update({ ctx: CTX, params: { id: 'res-9' }, body: { adults: 3 } }, ru, () => {});
  assert.equal(ru._json.ok, true);
  assert.equal(eng.calls[0].body.reservation_id, 'res-9');
  const rc = fakeRes(); await h.cancel({ ctx: CTX, params: { id: 'res-9' }, body: {} }, rc, () => {});
  assert.equal(rc._json.result.action, 'cancel');
  assert.equal(eng.calls[1].body.reservation_id, 'res-9');
});

test('tenant_required maps to 401', async () => {
  const eng = fakeEngine({ create: { ok: false, reason: 'tenant_required' } });
  const h = buildBookingHandlers({ bookingEngine: eng });
  const res = fakeRes();
  await h.create({ ctx: {}, body: {} }, res, () => {});
  assert.equal(res._status, 401);
});

test('router is graceful: no bookingEngine => only /quote route (always mounted)', () => {
  const r = build({});
  const paths = r.stack.filter((l) => l.route).map((l) => l.route.path);
  // /quote is always mounted even without bookingEngine
  assert.ok(paths.includes('/quote'), '/quote should always be mounted');
  // create/update/cancel should NOT be mounted without a bookingEngine
  assert.ok(!paths.includes('/create'), '/create should not be mounted without engine');
});

test('router with bookingEngine mounts /quote plus create/update/cancel', () => {
  const r2 = build({ bookingEngine: fakeEngine() });
  const paths = r2.stack.filter((l) => l.route).map((l) => l.route.path).sort();
  assert.ok(paths.includes('/quote'));
  assert.ok(paths.includes('/create'));
  assert.ok(paths.includes('/cancel/:id'));
  assert.ok(paths.includes('/update/:id'));
});

// Phase 52 D5 — Quote handler integration via booking.routes build

test('Phase 52: GET /booking/quote graceful when no ariService -> ari_not_configured', async () => {
  const { buildQuoteHandler } = require('../src/booking-engine/api/bookingHandlers');
  const handler = buildQuoteHandler(); // no ariService
  const res = { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
  const req = { ctx: { tenantId: 't1', propertyId: 'p1' }, query: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03' } };
  await handler(req, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.bookable, false);
  assert.equal(res._json.data.reason, 'ari_not_configured');
});

test('Phase 52: GET /booking/quote with mock ariService -> returns bookable result', async () => {
  const { buildQuoteHandler } = require('../src/booking-engine/api/bookingHandlers');
  const mockAriService = {
    async quoteStay() {
      return { bookable: true, total: 460, los: 2, available: 5, currency: 'USD', nights: [], reasons: [] };
    }
  };
  const handler = buildQuoteHandler({ ariService: mockAriService });
  const res = { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
  const req = { ctx: { tenantId: 't1', propertyId: 'p1' }, query: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', rate_plan_id: 'rp1' } };
  await handler(req, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.bookable, true);
  assert.equal(res._json.data.total, 460);
  assert.equal(res._json.data.los, 2);
});
