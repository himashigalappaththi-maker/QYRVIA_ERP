'use strict';

/**
 * Phase 54 D10 — Two-phase booking / payment state machine tests (Items 2-6, 11).
 * Tests initiateBooking, confirmBooking, state transitions, events, and sanitization.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildBookingService }          = require('../src/booking-engine/bookingService');
const { buildMockPaymentProvider }     = require('../src/payment/mockPaymentProvider');
const { buildPaymentStateStoreMemory } = require('../src/payment/paymentStateStore');
const { buildPaymentAttemptLogMemory } = require('../src/payment/paymentAttemptLog');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

// ---- helpers -----------------------------------------------------------------

function fakeCommandBus() {
  let n = 0;
  return {
    async dispatch(name) { return { ok: true, result: { id: 'res-' + (++n) } }; }
  };
}

function makeAvailEngine(available = true) {
  return {
    async check() {
      return { available, rooms: available ? 5 : 0, reason: available ? undefined : 'no_availability' };
    }
  };
}

function fakePricing() {
  return { quote() { return { ok: true, total: 230, base_rate: 200, taxes: 30, discounts: 0, currency: 'USD' }; } };
}

function fakeValidator() {
  return { validate() { return { ok: true }; } };
}

/**
 * Build a full booking service with all payment dependencies wired.
 */
function buildFullSvc({
  events = [],
  paymentProvider,
  paymentStateStore,
  paymentAttemptLog,
  available = true,
  validatorOverride = null,
} = {}) {
  return buildBookingService({
    commandBus:         fakeCommandBus(),
    availabilityEngine: makeAvailEngine(available),
    pricingEngine:      fakePricing(),
    validator:          validatorOverride || fakeValidator(),
    paymentProvider:    paymentProvider  || buildMockPaymentProvider(),
    paymentStateStore:  paymentStateStore || buildPaymentStateStoreMemory(),
    paymentAttemptLog:  paymentAttemptLog  || buildPaymentAttemptLogMemory(),
    onEvent: (e) => events.push(e),
  });
}

function validInput(over = {}) {
  return Object.assign({
    channel:         'DIRECT',
    room_type_id:    'rt1',
    arrival:         '2026-08-01',
    departure:       '2026-08-03',
    adults:          2,
    holder_guest_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    currency:        'USD',
  }, over);
}

// ---- Scenario 1: initiateBooking with mock provider -> correct result shape ---

test('initiateBooking: returns payment_id, hold_expires_at, total in result', async () => {
  const svc = buildFullSvc();
  const r = await svc.initiateBooking(validInput(), CTX);

  assert.equal(r.ok, true);
  assert.ok(r.result, 'result should be present');
  assert.ok(r.result.payment_id, 'should have payment_id');
  assert.ok(r.result.hold_expires_at, 'should have hold_expires_at');
  assert.equal(typeof r.result.total, 'number', 'total should be a number');
  assert.ok(r.result.total > 0, 'total should be positive');
  assert.ok(r.result.reservation_id, 'should have reservation_id');
  assert.equal(r.result.action, 'initiate_payment');
});

// ---- Scenario 2: initiateBooking stores payment state as pending_payment -----

test('initiateBooking: stores payment state with status pending_payment', async () => {
  const stateStore = buildPaymentStateStoreMemory();
  const svc = buildFullSvc({ paymentStateStore: stateStore });

  const r = await svc.initiateBooking(validInput(), CTX);
  assert.ok(r.ok);

  const reservationId = r.result.reservation_id;
  const state = await stateStore.getByReservationId(reservationId);
  assert.ok(state, 'payment state should be stored');
  assert.equal(state.payment_status, 'pending_payment');
  assert.ok(state.hold_expires_at, 'hold_expires_at should be set');
  assert.ok(state.deposit_amount > 0, 'deposit_amount should be positive');
  assert.ok(state.deposit_currency, 'deposit_currency should be set');
});

// ---- Scenario 3: confirmBooking success path --------------------------------

test('confirmBooking: verified payment -> calls PMS confirm, returns action: confirm', async () => {
  const stateStore = buildPaymentStateStoreMemory();
  const events = [];
  const svc = buildFullSvc({ paymentStateStore: stateStore, events });

  const initResult = await svc.initiateBooking(validInput(), CTX);
  assert.ok(initResult.ok);

  const reservationId = initResult.result.reservation_id;
  const paymentId     = initResult.result.payment_id;

  const confirmResult = await svc.confirmBooking({
    reservationId, paymentId,
    roomTypeId: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', adults: 2,
  }, CTX);

  assert.ok(confirmResult.ok, 'confirm should succeed');
  assert.equal(confirmResult.result.action, 'confirm');
  assert.ok(confirmResult.result.reservation_id, 'confirmed result should have reservation_id');
});

// ---- Scenario 4: confirmBooking when state is not pending_payment -----------

test('confirmBooking: non-pending_payment state -> returns invalid_payment_state', async () => {
  const stateStore = buildPaymentStateStoreMemory();
  const svc = buildFullSvc({ paymentStateStore: stateStore });

  // Manually insert a state that is already 'paid'
  await stateStore.upsert({
    reservation_id:  'res-already-paid',
    payment_status:  'paid',
    deposit_amount:  230,
    deposit_currency: 'USD',
    hold_expires_at: new Date(Date.now() + 900000).toISOString(),
    provider:        'mock',
    provider_ref:    'pay_xyz',
  });

  const confirmResult = await svc.confirmBooking({
    reservationId: 'res-already-paid',
    paymentId: 'pay_xyz',
  }, CTX);

  assert.equal(confirmResult.ok, false);
  assert.equal(confirmResult.reason, 'invalid_payment_state');
  assert.ok(Array.isArray(confirmResult.detail));
  assert.ok(confirmResult.detail.some(d => d.state === 'paid'), 'detail should include the current state');
});

// ---- Scenario 5: confirmBooking when hold_expires_at is in the past ---------

test('confirmBooking: expired hold -> returns hold_expired, sets state to failed', async () => {
  const stateStore = buildPaymentStateStoreMemory();
  const svc = buildFullSvc({ paymentStateStore: stateStore });

  // Insert a state with past hold_expires_at
  const pastTime = new Date(Date.now() - 1000).toISOString(); // 1 second ago
  await stateStore.upsert({
    reservation_id:  'res-expired',
    payment_status:  'pending_payment',
    deposit_amount:  230,
    deposit_currency: 'USD',
    hold_expires_at: pastTime,
    provider:        'mock',
    provider_ref:    'pay_expired',
  });

  const confirmResult = await svc.confirmBooking({
    reservationId: 'res-expired',
    paymentId: 'pay_expired',
  }, CTX);

  assert.equal(confirmResult.ok, false);
  assert.equal(confirmResult.reason, 'hold_expired');

  // Verify state updated to failed
  const state = await stateStore.getByReservationId('res-expired');
  assert.equal(state.payment_status, 'failed');
});

// ---- Scenario 6: confirmBooking when provider.verify() returns status: 'failed' ---

test('confirmBooking: provider.verify returns failed -> returns payment_verification_failed, sets state to failed', async () => {
  const failingProvider = {
    async initiate() { return { ok: true, paymentId: 'pay_fail_test', clientSecret: null, provider: 'mock' }; },
    async verify()   { return { ok: false, status: 'failed', provider: 'mock' }; },
  };

  const stateStore = buildPaymentStateStoreMemory();
  const svc = buildFullSvc({ paymentProvider: failingProvider, paymentStateStore: stateStore });

  const initResult = await svc.initiateBooking(validInput(), CTX);
  assert.ok(initResult.ok);

  const reservationId = initResult.result.reservation_id;

  const confirmResult = await svc.confirmBooking({
    reservationId,
    paymentId: initResult.result.payment_id,
  }, CTX);

  assert.equal(confirmResult.ok, false);
  assert.equal(confirmResult.reason, 'payment_verification_failed');

  // State should be set to failed
  const state = await stateStore.getByReservationId(reservationId);
  assert.ok(state, 'state should exist');
  assert.equal(state.payment_status, 'failed');
});

// ---- Scenario 7: failed payment attempt logged to paymentAttemptLog ----------

test('paymentAttemptLog: failed confirm attempt is logged', async () => {
  const failingProvider = {
    async initiate() { return { ok: true, paymentId: 'pay_fail_log', clientSecret: null, provider: 'mock' }; },
    async verify()   { return { ok: false, status: 'failed', provider: 'mock' }; },
  };

  const stateStore = buildPaymentStateStoreMemory();
  const attemptLog = buildPaymentAttemptLogMemory();
  const svc = buildFullSvc({ paymentProvider: failingProvider, paymentStateStore: stateStore, paymentAttemptLog: attemptLog });

  const initResult = await svc.initiateBooking(validInput(), CTX);
  assert.ok(initResult.ok);

  const reservationId = initResult.result.reservation_id;
  await svc.confirmBooking({ reservationId, paymentId: initResult.result.payment_id }, CTX);

  const logs = attemptLog.listByReservation(reservationId);
  assert.ok(logs.length >= 1, 'at least one attempt logged for this reservation');
  const failedLog = logs.find(l => l.status === 'failed');
  assert.ok(failedLog, 'failed attempt should be logged');
});

// ---- Scenario 8: successful confirm attempt logged to paymentAttemptLog ------

test('paymentAttemptLog: successful confirm attempt logged with status: success', async () => {
  const stateStore = buildPaymentStateStoreMemory();
  const attemptLog = buildPaymentAttemptLogMemory();
  const svc = buildFullSvc({ paymentStateStore: stateStore, paymentAttemptLog: attemptLog });

  const initResult = await svc.initiateBooking(validInput(), CTX);
  assert.ok(initResult.ok);

  const reservationId = initResult.result.reservation_id;
  const confirmResult = await svc.confirmBooking({ reservationId, paymentId: initResult.result.payment_id }, CTX);
  assert.ok(confirmResult.ok);

  const logs = attemptLog.listByReservation(reservationId);
  const successLog = logs.find(l => l.status === 'success');
  assert.ok(successLog, 'success attempt should be logged');
  assert.ok(successLog.reservation_id, 'success log should have reservation_id');
});

// ---- Scenario 9: cancelBooking still works from confirmed state ---------------

test('cancelBooking: cancel from existing reservation still works (existing path unchanged)', async () => {
  // cancelBooking does NOT require payment state — it uses the existing cancel path
  const svc = buildFullSvc();
  const r = await svc.cancelBooking({ reservation_id: 'res-to-cancel', external_ref: 'EXT-1' }, CTX);
  assert.ok(r.ok, 'cancel should succeed');
  assert.equal(r.action, 'cancel');
});

// ---- Scenario 10: initiateBooking emits booking.payment_initiated (not booking.created) ---

test('initiateBooking: emits booking.payment_initiated event, NOT booking.created', async () => {
  const events = [];
  const svc = buildFullSvc({ events });
  const r = await svc.initiateBooking(validInput(), CTX);
  assert.ok(r.ok);

  const paymentInitEvent = events.find(e => e.type === 'booking.payment_initiated');
  const createdEvent     = events.find(e => e.type === 'booking.created');

  assert.ok(paymentInitEvent, 'should emit booking.payment_initiated');
  assert.equal(createdEvent, undefined, 'should NOT emit booking.created on initiate');
});

// ---- Scenario 11: confirmBooking emits booking.created event on success ------

test('confirmBooking: emits booking.created event on success', async () => {
  const stateStore = buildPaymentStateStoreMemory();
  const events = [];
  const svc = buildFullSvc({ paymentStateStore: stateStore, events });

  const initResult = await svc.initiateBooking(validInput(), CTX);
  assert.ok(initResult.ok);
  events.length = 0; // clear initiate events

  const reservationId = initResult.result.reservation_id;
  const confirmResult = await svc.confirmBooking({ reservationId, paymentId: initResult.result.payment_id }, CTX);
  assert.ok(confirmResult.ok);

  const createdEvent = events.find(e => e.type === 'booking.created');
  assert.ok(createdEvent, 'should emit booking.created on successful confirm');
  assert.ok(createdEvent.reservationId || createdEvent.reservation_id, 'event should include reservation identifier');
});

// ---- Scenario 12: Payment provider result sanitized — no client_secret in events ---

test('initiateBooking: client_secret/clientSecret fields do not appear in emitted events', async () => {
  // Provider that returns a client_secret
  const sensitiveProvider = {
    async initiate() {
      return { ok: true, paymentId: 'pay_secret', clientSecret: 'cs_live_SUPERSECRETSHOULDNOTLEAK', client_secret: 'also_secret', provider: 'mock' };
    },
    async verify() { return { ok: true, status: 'paid', provider: 'mock' }; },
  };

  const events = [];
  const svc = buildFullSvc({ paymentProvider: sensitiveProvider, events });

  const r = await svc.initiateBooking(validInput(), CTX);
  assert.ok(r.ok);

  for (const ev of events) {
    assert.equal(ev.clientSecret,   undefined, `event.type=${ev.type}: clientSecret must not be in event`);
    assert.equal(ev.client_secret,  undefined, `event.type=${ev.type}: client_secret must not be in event`);
  }
});

// ---- Scenario 13: initiateBooking with availability=0 -> AVAILABILITY_FAILED, no PMS dispatch ---

test('initiateBooking: availability=0 -> AVAILABILITY_FAILED, no PMS dispatch', async () => {
  const events = [];
  const svc = buildFullSvc({ available: false, events });

  const r = await svc.initiateBooking(validInput(), CTX);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AVAILABILITY_FAILED');
  assert.ok(Array.isArray(r.detail), 'should have detail array');

  // No payment_initiated event
  const paymentInitEvent = events.find(e => e.type === 'booking.payment_initiated');
  assert.equal(paymentInitEvent, undefined, 'should not emit payment_initiated when availability fails');
});

// ---- Additional: payment_id from mock provider has correct prefix ------------

test('mockPaymentProvider: initiate returns paymentId with mock_ prefix', async () => {
  const provider = buildMockPaymentProvider();
  const result = await provider.initiate({ amount: 100, currency: 'USD', bookingRef: 'res-1' });
  assert.ok(result.ok);
  assert.ok(result.paymentId.startsWith('mock_pay_'), 'mock paymentId should have mock_pay_ prefix');
  assert.equal(result.provider, 'mock');
});

// ---- Additional: mockPaymentProvider verify always returns paid ---------------

test('mockPaymentProvider: verify always returns status: paid', async () => {
  const provider = buildMockPaymentProvider();
  const result = await provider.verify({ paymentId: 'mock_pay_123' });
  assert.ok(result.ok);
  assert.equal(result.status, 'paid');
});

// ---- Additional: paymentStateStore findExpiredHolds -------------------------

test('paymentStateStore: findExpiredHolds returns only expired pending_payment records', async () => {
  const store = buildPaymentStateStoreMemory();

  // Past hold (expired)
  store.upsert({
    reservation_id:   'res-past',
    payment_status:   'pending_payment',
    hold_expires_at:  new Date(Date.now() - 5000).toISOString(),
  });

  // Future hold (not expired)
  store.upsert({
    reservation_id:   'res-future',
    payment_status:   'pending_payment',
    hold_expires_at:  new Date(Date.now() + 900000).toISOString(),
  });

  // Already paid (should not appear in expired holds)
  store.upsert({
    reservation_id:   'res-paid',
    payment_status:   'paid',
    hold_expires_at:  new Date(Date.now() - 5000).toISOString(),
  });

  const expired = store.findExpiredHolds();
  assert.equal(expired.length, 1, 'only 1 expired pending_payment record');
  assert.equal(expired[0].reservation_id, 'res-past');
});

// ---- Additional: paymentStateStore upsert updates existing record ------------

test('paymentStateStore: upsert updates existing record by reservation_id', async () => {
  const store = buildPaymentStateStoreMemory();

  await store.upsert({ reservation_id: 'res-upsert', payment_status: 'pending_payment', deposit_amount: 100 });
  await store.upsert({ reservation_id: 'res-upsert', payment_status: 'paid', paid_at: '2026-08-01T12:00:00.000Z' });

  const state = await store.getByReservationId('res-upsert');
  assert.ok(state, 'record should exist');
  assert.equal(state.payment_status, 'paid', 'status should be updated');
  assert.ok(state.paid_at, 'paid_at should be set');
  // id should be stable (same record)
  assert.ok(state.id, 'should have an id');
});

// ---- Additional: paymentAttemptLog listByReservation -------------------------

test('paymentAttemptLog: listByReservation returns only entries for that reservation', () => {
  const log = buildPaymentAttemptLogMemory();

  log.insert({ reservation_id: 'res-A', status: 'initiated', amount: 100 });
  log.insert({ reservation_id: 'res-A', status: 'success',   amount: 100 });
  log.insert({ reservation_id: 'res-B', status: 'initiated', amount: 200 });

  const logsA = log.listByReservation('res-A');
  const logsB = log.listByReservation('res-B');

  assert.equal(logsA.length, 2, 'res-A should have 2 log entries');
  assert.equal(logsB.length, 1, 'res-B should have 1 log entry');
  assert.ok(logsA.every(l => l.reservation_id === 'res-A'), 'all res-A entries should match');
});
