'use strict';

/**
 * Phase 55 — Direct booking idempotency tests.
 * Verifies that initiateBooking deduplicates on idempotency_key, rejects
 * terminal states cleanly, and never creates a second PMS reservation for
 * a key that already has an active hold.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildBookingService }          = require('../src/booking-engine/bookingService');
const { buildMockPaymentProvider }     = require('../src/payment/mockPaymentProvider');
const { buildPaymentStateStoreMemory } = require('../src/payment/paymentStateStore');
const { buildPaymentAttemptLogMemory } = require('../src/payment/paymentAttemptLog');

const CTX_A = { tenantId: 't-idem-a', propertyId: 'p-idem-a', requestId: 'rq', actorId: 'u1' };
const CTX_B = { tenantId: 't-idem-b', propertyId: 'p-idem-b', requestId: 'rq', actorId: 'u2' };

function fakeCommandBus() {
  const dispatched = [];
  const busId = Math.random().toString(36).slice(2, 8);
  let n = 0;
  return {
    dispatched,
    async dispatch(name) { dispatched.push(name); return { ok: true, result: { id: busId + '-res-' + (++n) } }; }
  };
}

function makeAvailEngine(available = true) {
  return { async check() { return { available, rooms: available ? 5 : 0 }; } };
}

function fakePricing() {
  return { quote() { return { ok: true, total: 200, base_rate: 180, taxes: 20, discounts: 0, currency: 'USD' }; } };
}

function fakeValidator() { return { validate() { return { ok: true }; } }; }

const BASE_INPUT = {
  channel: 'DIRECT', room_type_id: 'rt1',
  arrival: '2026-09-01', departure: '2026-09-03',
  adults: 2, base_rate: 100, currency: 'USD',
  holder_guest_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
};

// ── 1. Same idempotency_key twice → second call returns idempotent result ────

test('initiateBooking: same idempotency_key returns idempotent result on second call', async () => {
  const bus = fakeCommandBus();
  const paymentStateStore = buildPaymentStateStoreMemory();
  let storedReservation = null;

  const svc = buildBookingService({
    commandBus: bus,
    availabilityEngine: makeAvailEngine(true),
    pricingEngine: fakePricing(),
    validator: fakeValidator(),
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore,
    paymentAttemptLog: buildPaymentAttemptLogMemory(),
    findReservationByIdempotencyKey: async (_tid, _key) => storedReservation,
  });

  const input = Object.assign({}, BASE_INPUT, { idempotency_key: 'idem-key-001' });

  const r1 = await svc.initiateBooking(input, CTX_A);
  assert.equal(r1.ok, true, 'first call should succeed');
  assert.equal(r1.result.action, 'initiate_payment');

  // Simulate what pmsRepo.insertReservation + DB persistence would have done
  storedReservation = { id: r1.result.reservation_id };

  const r2 = await svc.initiateBooking(input, CTX_A);
  assert.equal(r2.ok, true, 'second call should succeed (idempotent)');
  assert.equal(r2.result.idempotent, true, 'result must carry idempotent flag');
  assert.equal(r2.result.reservation_id, r1.result.reservation_id, 'same reservation_id on both calls');
  assert.equal(r2.result.action, 'initiate_payment');

  // Only one PMS create dispatch for two calls with the same key
  const creates = bus.dispatched.filter((n) => n === 'pms.reservation.create');
  assert.equal(creates.length, 1, 'exactly one PMS dispatch for idempotent pair');
});

// ── 2. Same key after payment confirmed → booking_already_confirmed ──────────

test('initiateBooking: same key after paid state → booking_already_confirmed', async () => {
  const bus = fakeCommandBus();
  const paymentStateStore = buildPaymentStateStoreMemory();
  let storedReservation = null;

  const svc = buildBookingService({
    commandBus: bus,
    availabilityEngine: makeAvailEngine(true),
    pricingEngine: fakePricing(),
    validator: fakeValidator(),
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore,
    paymentAttemptLog: buildPaymentAttemptLogMemory(),
    findReservationByIdempotencyKey: async (_tid, _key) => storedReservation,
  });

  const input = Object.assign({}, BASE_INPUT, { idempotency_key: 'idem-paid-key' });

  const r1 = await svc.initiateBooking(input, CTX_A);
  assert.equal(r1.ok, true);
  storedReservation = { id: r1.result.reservation_id };

  // Simulate the payment being confirmed
  await paymentStateStore.upsert({ reservation_id: r1.result.reservation_id, payment_status: 'paid' });

  const r2 = await svc.initiateBooking(input, CTX_A);
  assert.equal(r2.ok, false, 'should reject when booking already confirmed');
  assert.equal(r2.reason, 'booking_already_confirmed');
});

// ── 3. Same key after payment failed → payment_already_failed ────────────────

test('initiateBooking: same key after failed state → payment_already_failed', async () => {
  const bus = fakeCommandBus();
  const paymentStateStore = buildPaymentStateStoreMemory();
  let storedReservation = null;

  const svc = buildBookingService({
    commandBus: bus,
    availabilityEngine: makeAvailEngine(true),
    pricingEngine: fakePricing(),
    validator: fakeValidator(),
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore,
    paymentAttemptLog: buildPaymentAttemptLogMemory(),
    findReservationByIdempotencyKey: async (_tid, _key) => storedReservation,
  });

  const input = Object.assign({}, BASE_INPUT, { idempotency_key: 'idem-failed-key' });

  const r1 = await svc.initiateBooking(input, CTX_A);
  assert.equal(r1.ok, true);
  storedReservation = { id: r1.result.reservation_id };

  await paymentStateStore.upsert({ reservation_id: r1.result.reservation_id, payment_status: 'failed' });

  const r2 = await svc.initiateBooking(input, CTX_A);
  assert.equal(r2.ok, false, 'should reject when payment already failed');
  assert.equal(r2.reason, 'payment_already_failed');
});

// ── 4. No idempotency_key → proceeds normally, no dedup ──────────────────────

test('initiateBooking: null idempotency_key → no dedup, both calls proceed', async () => {
  const bus = fakeCommandBus();
  let lookupCalled = false;

  const svc = buildBookingService({
    commandBus: bus,
    availabilityEngine: makeAvailEngine(true),
    pricingEngine: fakePricing(),
    validator: fakeValidator(),
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore: buildPaymentStateStoreMemory(),
    paymentAttemptLog: buildPaymentAttemptLogMemory(),
    findReservationByIdempotencyKey: async () => { lookupCalled = true; return null; },
  });

  // No idempotency_key in input
  const input = Object.assign({}, BASE_INPUT);

  const r1 = await svc.initiateBooking(input, CTX_A);
  const r2 = await svc.initiateBooking(input, CTX_A);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(lookupCalled, false, 'lookup should not be called when no key is provided');

  // Two PMS dispatches (no dedup without key)
  const creates = bus.dispatched.filter((n) => n === 'pms.reservation.create');
  assert.equal(creates.length, 2, 'two PMS dispatches without idempotency key');
});

// ── 5. Same key different tenants → both succeed, no cross-tenant collision ──

test('initiateBooking: same key from tenant A and B → both succeed independently', async () => {
  const storeA = { reservation: null };
  const storeB = { reservation: null };

  function makeSvc(ctx, storeRef) {
    const bus = fakeCommandBus();
    const svc = buildBookingService({
      commandBus: bus,
      availabilityEngine: makeAvailEngine(true),
      pricingEngine: fakePricing(),
      validator: fakeValidator(),
      paymentProvider: buildMockPaymentProvider(),
      paymentStateStore: buildPaymentStateStoreMemory(),
      paymentAttemptLog: buildPaymentAttemptLogMemory(),
      findReservationByIdempotencyKey: async (tid, _key) =>
        tid === ctx.tenantId ? storeRef.reservation : null,
    });
    return { svc, bus };
  }

  const { svc: svcA, bus: busA } = makeSvc(CTX_A, storeA);
  const { svc: svcB, bus: busB } = makeSvc(CTX_B, storeB);

  const KEY = 'shared-key-across-tenants';
  const inputA = Object.assign({}, BASE_INPUT, { idempotency_key: KEY });
  const inputB = Object.assign({}, BASE_INPUT, { idempotency_key: KEY });

  const rA = await svcA.initiateBooking(inputA, CTX_A);
  const rB = await svcB.initiateBooking(inputB, CTX_B);

  assert.equal(rA.ok, true, 'tenant A should succeed');
  assert.equal(rB.ok, true, 'tenant B should succeed independently');
  assert.notEqual(rA.result.reservation_id, rB.result.reservation_id, 'different reservation IDs');
  assert.equal(busA.dispatched.filter((n) => n === 'pms.reservation.create').length, 1);
  assert.equal(busB.dispatched.filter((n) => n === 'pms.reservation.create').length, 1);
});
