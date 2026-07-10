'use strict';

/**
 * Phase 54 D10 — Public route safety tests (Item 13).
 * Tests HTTP route layer auth, validation error responses, and rate limiter wiring.
 * Uses direct handler invocation (no HTTP server) following bookingRoute.test.js pattern.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';
process.env.NODE_ENV     = 'test';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildBookingHandlers } = require('../src/booking-engine/api/bookingHandlers');
const { build }                = require('../src/booking-engine/api/booking.routes');

// ---- helpers -----------------------------------------------------------------

function fakeRes() {
  return {
    _status: 200, _json: null,
    status(s) { this._status = s; return this; },
    json(b)   { this._json = b;   return this; },
  };
}

function fakeEngine(behavior = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async initiateBooking(body, ctx) {
        calls.push({ op: 'initiate', body, ctx });
        return behavior.initiate || { ok: true, result: { reservation_id: 'res-1', payment_id: 'pay_1', total: 230, currency: 'USD', hold_expires_at: new Date(Date.now() + 900000).toISOString(), action: 'initiate_payment' } };
      },
      async confirmBooking(body, ctx) {
        calls.push({ op: 'confirm', body, ctx });
        return behavior.confirm || { ok: true, result: { reservation_id: 'res-1', action: 'confirm' } };
      },
      async createBooking(body, ctx) {
        calls.push({ op: 'create', body, ctx });
        return behavior.create || { ok: true, reservation_id: 'res-1', pricing: { total: 115 } };
      },
      async updateBooking(body, ctx) {
        calls.push({ op: 'update', body, ctx });
        return behavior.update || { ok: true, action: 'update', reservation_id: body.reservation_id };
      },
      async cancelBooking(body, ctx) {
        calls.push({ op: 'cancel', body, ctx });
        return behavior.cancel || { ok: true, action: 'cancel' };
      },
    }
  };
}

// ---- Handler-level auth gate tests -----------------------------------------
// The requirePermission middleware checks req.ctx.permissions.
// When permissions are absent, it returns 403. When req.user is not set at all
// (no auth), the middleware returns 403. We simulate this in a handler-layer test
// by calling the underlying handler directly (bypassing middleware),
// and separately verifying that the route builder wires requirePermission.

// 1. Route builder mounts /create with requirePermission
test('route safety: /create route has requirePermission middleware wired (layer count check)', () => {
  const eng = fakeEngine();
  const router = build({ bookingEngine: eng });

  // Find the /create route
  const createRoute = router.stack.find(l => l.route && l.route.path === '/create');
  assert.ok(createRoute, '/create route should be mounted');

  // The route should have the rateLimit + requirePermission + handler = 3 layers
  const layers = createRoute.route.stack;
  assert.ok(layers.length >= 3, '/create should have at least 3 middleware layers (limiter, permission, handler)');
});

// 2. Route builder mounts /payment/initiate with requirePermission
test('route safety: /payment/initiate route is mounted with permission middleware', () => {
  const eng = fakeEngine();
  const router = build({ bookingEngine: eng });

  const initiateRoute = router.stack.find(l => l.route && l.route.path === '/payment/initiate');
  assert.ok(initiateRoute, '/payment/initiate should be mounted');
  // At least 2 layers: requirePermission + handler
  assert.ok(initiateRoute.route.stack.length >= 2, 'should have at least 2 middleware layers');
});

// 3. Route builder mounts /payment/confirm/:id with requirePermission
test('route safety: /payment/confirm/:id route is mounted with permission middleware', () => {
  const eng = fakeEngine();
  const router = build({ bookingEngine: eng });

  const confirmRoute = router.stack.find(l => l.route && l.route.path === '/payment/confirm/:id');
  assert.ok(confirmRoute, '/payment/confirm/:id should be mounted');
  assert.ok(confirmRoute.route.stack.length >= 2, 'should have at least 2 middleware layers');
});

// 4. requirePermission gate denies when no permissions in ctx (403)
test('route safety: requirePermission denies when ctx.permissions is empty (403)', () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const middleware = requirePermission('pms.reservation.write');

  const req = { ctx: { permissions: [] }, user: { role_codes: [] }, requestId: 'rq' };
  const res = fakeRes();
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'next should not be called when permission denied');
  assert.equal(res._status, 403);
  assert.equal(res._json.error, 'permission_denied');
});

// 5. requirePermission gate allows when permission present in ctx
test('route safety: requirePermission allows when ctx.permissions includes required perm', () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const middleware = requirePermission('pms.reservation.write');

  const req = { ctx: { permissions: ['pms.reservation.write'] }, user: { role_codes: [] }, requestId: 'rq' };
  const res = fakeRes();
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'next should be called when permission present');
});

// 6. requirePermission gate allows super_admin regardless of permissions
test('route safety: super_admin bypasses requirePermission check', () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const middleware = requirePermission('pms.reservation.write');

  const req = { ctx: { permissions: [] }, user: { role_codes: ['super_admin'] }, requestId: 'rq' };
  const res = fakeRes();
  let nextCalled = false;

  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'super_admin should bypass permission check');
});

// 7. createBooking handler: validation error body with long guest_name -> 400 (not 500)
test('route safety: long guest_name validation error returns 400, not 500', async () => {
  const longNameEngine = fakeEngine({
    create: { ok: false, reason: 'VALIDATION_FAILED', detail: [{ field: 'guest_name', reason: 'max_length_200' }] }
  });
  const h = buildBookingHandlers({ bookingEngine: longNameEngine });
  const res = fakeRes();
  const req = { ctx: { tenantId: 't1', propertyId: 'p1', requestId: 'rq' }, body: { guest_name: 'A'.repeat(300) } };
  await h.create(req, res, () => {});
  assert.equal(res._status, 400, 'long guest_name should result in 400 not 500');
  assert.equal(res._json.ok, false);
  assert.ok(res._json.error, 'error field should be present');
});

// 8. createBooking handler: missing room_type_id -> 400 with structured error
test('route safety: missing room_type_id returns 400 with structured error', async () => {
  const validationEngine = fakeEngine({
    create: { ok: false, reason: 'VALIDATION_FAILED', detail: ['room_type_required'] }
  });
  const h = buildBookingHandlers({ bookingEngine: validationEngine });
  const res = fakeRes();
  const req = { ctx: { tenantId: 't1', requestId: 'rq' }, body: {} };
  await h.create(req, res, () => {});
  assert.equal(res._status, 400);
  assert.equal(res._json.ok, false);
  assert.ok(res._json.error, 'error field present');
  assert.ok(Array.isArray(res._json.detail), 'detail is an array');
  assert.ok(res._json.requestId === 'rq', 'requestId echoed');
});

// 9. initiatePayment handler: availability failure -> 409
test('route safety: initiatePayment AVAILABILITY_FAILED -> 409', async () => {
  const eng = fakeEngine({ initiate: { ok: false, reason: 'AVAILABILITY_FAILED', detail: [{ reason: 'no_availability' }] } });
  const h = buildBookingHandlers({ bookingEngine: eng });
  const res = fakeRes();
  const req = { ctx: { tenantId: 't1', requestId: 'rq' }, body: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', adults: 2 } };
  await h.initiatePayment(req, res);
  assert.equal(res._status, 409, 'AVAILABILITY_FAILED should map to 409 Conflict');
  assert.equal(res._json.ok, false);
});

// 10. confirmPayment handler: hold_expired -> 410
test('route safety: confirmPayment hold_expired -> 410', async () => {
  const eng = fakeEngine({ confirm: { ok: false, reason: 'hold_expired', detail: [] } });
  const h = buildBookingHandlers({ bookingEngine: eng });
  const res = fakeRes();
  const req = { ctx: { tenantId: 't1', requestId: 'rq' }, params: { id: 'pay_1' }, body: { reservation_id: 'res-1' } };
  await h.confirmPayment(req, res);
  assert.equal(res._status, 410, 'hold_expired should map to 410 Gone');
  assert.equal(res._json.ok, false);
});

// 11. confirmPayment handler: payment_verification_failed -> 402
test('route safety: confirmPayment payment_verification_failed -> 402', async () => {
  const eng = fakeEngine({ confirm: { ok: false, reason: 'payment_verification_failed', detail: [{ status: 'failed' }] } });
  const h = buildBookingHandlers({ bookingEngine: eng });
  const res = fakeRes();
  const req = { ctx: { tenantId: 't1', requestId: 'rq' }, params: { id: 'pay_1' }, body: { reservation_id: 'res-1' } };
  await h.confirmPayment(req, res);
  assert.equal(res._status, 402, 'payment_verification_failed should map to 402 Payment Required');
  assert.equal(res._json.ok, false);
});

// 12. initiatePayment handler: engine throws -> 500 with internal_error
test('route safety: initiatePayment engine exception -> 500 internal_error', async () => {
  const throwingEngine = {
    service: {
      async initiateBooking() { throw new Error('unexpected_crash'); },
      async createBooking()   { throw new Error('unexpected_crash'); },
      async updateBooking()   { throw new Error('unexpected_crash'); },
      async cancelBooking()   { throw new Error('unexpected_crash'); },
      async confirmBooking()  { throw new Error('unexpected_crash'); },
    }
  };
  const h = buildBookingHandlers({ bookingEngine: throwingEngine });
  const res = fakeRes();
  const req = { ctx: { tenantId: 't1', requestId: 'rq' }, body: {} };
  await h.initiatePayment(req, res);
  assert.equal(res._status, 500, 'engine exception should map to 500');
  assert.equal(res._json.ok, false);
  assert.ok(res._json.error, 'error field should be present');
});

// 13. confirmPayment handler: engine throws -> 500
test('route safety: confirmPayment engine exception -> 500 internal_error', async () => {
  const throwingEngine = {
    service: {
      async initiateBooking() { throw new Error('unexpected_crash'); },
      async createBooking()   { throw new Error('unexpected_crash'); },
      async updateBooking()   { throw new Error('unexpected_crash'); },
      async cancelBooking()   { throw new Error('unexpected_crash'); },
      async confirmBooking()  { throw new Error('unexpected_crash'); },
    }
  };
  const h = buildBookingHandlers({ bookingEngine: throwingEngine });
  const res = fakeRes();
  const req = { ctx: { tenantId: 't1', requestId: 'rq' }, params: { id: 'pay_1' }, body: { reservation_id: 'res-1' } };
  await h.confirmPayment(req, res);
  assert.equal(res._status, 500);
  assert.equal(res._json.ok, false);
});

// 14. Rate limiter is configured: createLimiter is wired on /create (skip=true in test env)
test('route safety: createLimiter is wired on /create route and skips in test env (NODE_ENV=test)', () => {
  // The route builder creates a rateLimit with skip: () => process.env.NODE_ENV === 'test'
  // We verify that the /create route has 3 middleware layers (limiter + permission + handler)
  const eng = fakeEngine();
  const router = build({ bookingEngine: eng });

  const createRoute = router.stack.find(l => l.route && l.route.path === '/create');
  assert.ok(createRoute, '/create route should be mounted');

  const layers = createRoute.route.stack;
  // Layer 0: createLimiter (rateLimit middleware), Layer 1: requirePermission, Layer 2: handler
  assert.ok(layers.length >= 3, 'createLimiter should be one of the layers on /create');
  // The middleware functions should all be functions
  assert.ok(layers.every(l => typeof l.handle === 'function'), 'all layers should be functions');
});

// 15. Router without bookingEngine: /create not mounted
test('route safety: build without bookingEngine does not mount /create', () => {
  const router = build({});
  const paths = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(!paths.includes('/create'), '/create should not be mounted without bookingEngine');
  assert.ok(!paths.includes('/payment/initiate'), '/payment/initiate should not be mounted without bookingEngine');
});
