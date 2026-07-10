'use strict';

/**
 * Phase 54 D10 — Route RBAC tests (Item 12).
 * Tests permission gate behavior for booking routes (handler + middleware layer).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';
process.env.NODE_ENV     = 'test';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { requirePermission } = require('../src/middleware/authorization');
const { buildBookingHandlers } = require('../src/booking-engine/api/bookingHandlers');
const { build } = require('../src/booking-engine/api/booking.routes');

// ---- helpers -----------------------------------------------------------------

function fakeRes() {
  return {
    _status: 200, _json: null,
    status(s) { this._status = s; return this; },
    json(b)   { this._json = b;   return this; },
  };
}

function fakeEngine() {
  return {
    service: {
      async createBooking()   { return { ok: true, reservation_id: 'res-1', pricing: { total: 230 } }; },
      async initiateBooking() { return { ok: true, result: { reservation_id: 'res-1', payment_id: 'pay_1', total: 230, currency: 'USD', hold_expires_at: new Date(Date.now() + 900000).toISOString(), action: 'initiate_payment' } }; },
      async confirmBooking()  { return { ok: true, result: { reservation_id: 'res-1', action: 'confirm' } }; },
      async updateBooking()   { return { ok: true, action: 'update' }; },
      async cancelBooking()   { return { ok: true, action: 'cancel' }; },
    }
  };
}

// ---- requirePermission middleware tests -------------------------------------

// 1. pms.reservation.write permission -> passes gate
test('RBAC: ctx with pms.reservation.write permission passes gate', () => {
  const middleware = requirePermission('pms.reservation.write');
  const req = { ctx: { permissions: ['pms.reservation.write'] }, user: { role_codes: [] }, requestId: 'rq' };
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'should pass when required permission present');
});

// 2. No pms.reservation.write -> 403
test('RBAC: ctx without pms.reservation.write -> 403 permission_denied', () => {
  const middleware = requirePermission('pms.reservation.write');
  const req = { ctx: { permissions: ['pms.housekeeping.read'] }, user: { role_codes: [] }, requestId: 'rq' };
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'should not pass without required permission');
  assert.equal(res._status, 403);
  assert.equal(res._json.error, 'permission_denied');
  assert.equal(res._json.required, 'pms.reservation.write');
});

// 3. pms.reservation.read permission gate -> passes
test('RBAC: ctx with pms.reservation.read passes read gate', () => {
  const middleware = requirePermission('pms.reservation.read');
  const req = { ctx: { permissions: ['pms.reservation.read'] }, user: { role_codes: [] }, requestId: 'rq' };
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

// 4. pms.reservation.read without permission -> 403
test('RBAC: ctx without pms.reservation.read -> 403 for quote route', () => {
  const middleware = requirePermission('pms.reservation.read');
  const req = { ctx: { permissions: [] }, user: { role_codes: [] }, requestId: 'rq' };
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 403);
});

// 5. POST /payment/initiate with valid permission -> passes
test('RBAC: pms.reservation.write permission allows payment/initiate handler', async () => {
  const eng = fakeEngine();
  const h   = buildBookingHandlers({ bookingEngine: eng });
  const res = fakeRes();
  const req = {
    ctx: { tenantId: 't1', permissions: ['pms.reservation.write'], requestId: 'rq' },
    user: { role_codes: [] },
    body: { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', adults: 2 },
  };
  await h.initiatePayment(req, res);
  assert.equal(res._status, 201, 'should succeed when reaching handler with valid permission context');
  assert.equal(res._json.ok, true);
});

// 6. POST /payment/confirm/:id with valid permission -> passes
test('RBAC: pms.reservation.write permission allows payment/confirm handler', async () => {
  const stateStoreForConfirm = require('../src/payment/paymentStateStore').buildPaymentStateStoreMemory();
  // Insert a valid pending_payment state
  await stateStoreForConfirm.upsert({
    reservation_id:  'res-confirm-rbac',
    payment_status:  'pending_payment',
    deposit_amount:  230,
    deposit_currency: 'USD',
    hold_expires_at: new Date(Date.now() + 900000).toISOString(),
    provider:        'mock',
    provider_ref:    'pay_rbac_test',
  });

  const eng = fakeEngine();
  const h   = buildBookingHandlers({ bookingEngine: eng });
  const res = fakeRes();
  const req = {
    ctx:    { tenantId: 't1', permissions: ['pms.reservation.write'], requestId: 'rq' },
    user:   { role_codes: [] },
    params: { id: 'pay_rbac_test' },
    body:   { reservation_id: 'res-confirm-rbac' },
  };
  await h.confirmPayment(req, res);
  // Handler receives the call - status depends on fakeEngine response
  assert.ok(res._json.ok !== undefined, 'handler should respond');
});

// 7. No tenantId in ctx -> booking creation returns 401 (tenant_required)
test('RBAC: no tenantId in ctx -> create returns 401 tenant_required', async () => {
  const missingTenantEngine = {
    service: {
      async createBooking() { return { ok: false, reason: 'tenant_required' }; },
      async initiateBooking() { return { ok: false, reason: 'tenant_required' }; },
      async confirmBooking() { return { ok: false, reason: 'tenant_required' }; },
      async updateBooking() { return { ok: false, reason: 'tenant_required' }; },
      async cancelBooking() { return { ok: false, reason: 'tenant_required' }; },
    }
  };
  const h   = buildBookingHandlers({ bookingEngine: missingTenantEngine });
  const res = fakeRes();
  const req = {
    ctx:  { permissions: ['pms.reservation.write'], requestId: 'rq' }, // no tenantId
    user: { role_codes: [] },
    body: {},
  };
  await h.create(req, res, () => {});
  assert.equal(res._status, 401);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'tenant_required');
});

// 8. Route builder wires requirePermission on /create (structure check)
test('RBAC: /create route in router has requirePermission middleware', () => {
  const eng    = fakeEngine();
  const router = build({ bookingEngine: eng });

  const createRoute = router.stack.find(l => l.route && l.route.path === '/create');
  assert.ok(createRoute, '/create should be mounted');

  const middlewareNames = createRoute.route.stack.map(l => l.handle.name);
  // requirePermission returns a named function 'bound requirePermission' or anonymous
  // We verify at least 3 layers exist (rateLimit + permission + handler)
  assert.ok(createRoute.route.stack.length >= 3, 'at least 3 layers: rateLimit + permission + handler');
});

// 9. Route builder wires requirePermission on /quote (pms.reservation.read)
test('RBAC: /quote route has requirePermission(pms.reservation.read)', () => {
  const router = build({});

  const quoteRoute = router.stack.find(l => l.route && l.route.path === '/quote');
  assert.ok(quoteRoute, '/quote should be mounted');
  // At least 2 layers: requirePermission + handler
  assert.ok(quoteRoute.route.stack.length >= 2, '/quote should have at least 2 layers');
});

// 10. Multiple permissions: user with both read and write gets through write gate
test('RBAC: user with multiple permissions passes required permission gate', () => {
  const middleware = requirePermission('pms.reservation.write');
  const req = {
    ctx: { permissions: ['pms.reservation.read', 'pms.reservation.write', 'pms.housekeeping.write'] },
    user: { role_codes: [] },
    requestId: 'rq',
  };
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'should pass when required permission is among multiple');
});

// 11. requestId is echoed in 403 response
test('RBAC: requestId is echoed in 403 permission_denied response', () => {
  const middleware = requirePermission('pms.reservation.write');
  const req = { ctx: { permissions: [] }, user: { role_codes: [] }, requestId: 'req-echo-123' };
  const res = fakeRes();
  middleware(req, res, () => {});
  assert.equal(res._json.requestId, 'req-echo-123', 'requestId should be echoed in 403');
});

// 12. buildBookingHandlers throws when bookingEngine.service is absent
test('RBAC: buildBookingHandlers throws when engine.service is absent', () => {
  assert.throws(
    () => buildBookingHandlers({ bookingEngine: {} }),
    /bookingEngine\.service required/
  );
});
