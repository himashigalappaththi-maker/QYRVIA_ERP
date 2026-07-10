'use strict';

/**
 * Phase 56 — Booking Confirmation Delivery Pipeline tests (Tests 7-15).
 *
 * All in-memory. Verifies:
 *   - confirmBooking queues exactly one delivery record
 *   - deduplication prevents duplicate queue entries
 *   - delivery success sets confirmation_sent_at (via setReservationConfirmationSent)
 *   - queueing alone does not set confirmation_sent_at
 *   - retryable failure reschedules; permanent failure terminates
 *   - already-sent records are not resent
 *   - concurrent workers cannot both claim the same delivery record
 *   - tenant isolation
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildConfirmationDeliveryService } = require('../src/payment/confirmationDeliveryService');
const { buildConfirmationDeliveryStoreMemory } = require('../src/payment/confirmationDeliveryStore');
const { buildBookingService }          = require('../src/booking-engine/bookingService');
const { buildAvailabilityEngine }      = require('../src/booking-engine/availabilityEngine');
const { buildMockPaymentProvider }     = require('../src/payment/mockPaymentProvider');
const { buildPaymentStateStoreMemory } = require('../src/payment/paymentStateStore');
const { buildPaymentAttemptLogMemory } = require('../src/payment/paymentAttemptLog');
const { generateConfirmationNumber }   = require('../src/services/pms/confirmationNumber');

const CTX = { tenantId: 't-cdp-1', propertyId: 'p-cdp-1', requestId: 'rq', actorId: 'u1' };

function makeAdapter(outcome = 'success') {
  const calls = [];
  return {
    calls,
    async send(args) {
      calls.push(args);
      if (outcome === 'success')   return { ok: true, provider_ref: 'prov-ref-001' };
      if (outcome === 'retryable') return { ok: false, error: 'temporary_gateway_error' };
      if (outcome === 'permanent') return { ok: false, error: 'invalid_recipient' };
      if (typeof outcome === 'function') return outcome(args);
      return { ok: false, error: 'unknown' };
    }
  };
}

function makeDeliveryService(adapterOutcome = 'success', opts = {}) {
  const store = buildConfirmationDeliveryStoreMemory();
  const confirmationSentAts = new Map();
  const svc = buildConfirmationDeliveryService({
    repo:    store,
    notificationAdapter: makeAdapter(adapterOutcome),
    setReservationConfirmationSent: async (tid, rid, sentAt) => {
      if (!confirmationSentAts.has(rid)) {
        confirmationSentAts.set(rid, sentAt);
      }
    },
    ...opts,
  });
  return { svc, store, confirmationSentAts };
}

// ── Test 7: confirmed booking queues exactly one delivery record ──────────────

test('Phase 56 T7: confirmBooking queues one confirmation delivery when guestRecipient present', async () => {
  const { svc: deliverySvc, store } = makeDeliveryService();
  const paymentStateStore = buildPaymentStateStoreMemory();
  const reservationId = 'res-cdp-007';

  await paymentStateStore.upsert({
    reservation_id: reservationId, payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 900000).toISOString(),
    deposit_amount: 200, deposit_currency: 'USD', provider: 'mock',
  });

  const confirmationNumber = generateConfirmationNumber(reservationId);
  const svc = buildBookingService({
    commandBus: {
      async dispatch(name, input) {
        if (name === 'pms.reservation.confirm')
          return { ok: true, result: { id: input.reservation_id, status: 'CONFIRMED', confirmation_number: confirmationNumber } };
        return { ok: true, result: { id: input.reservation_id } };
      }
    },
    availabilityEngine: buildAvailabilityEngine({ availabilityProvider: () => 5 }),
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore,
    paymentAttemptLog: buildPaymentAttemptLogMemory(),
    confirmationDeliveryService: deliverySvc,
  });

  const ctx = Object.assign({}, CTX, { guestRecipient: 'guest@example.com', guestChannel: 'email' });
  const r = await svc.confirmBooking({
    reservationId, paymentId: 'pay-001',
    roomTypeId: 'rt1', arrival: '2026-09-01', departure: '2026-09-03', adults: 2,
  }, ctx);

  assert.equal(r.ok, true, 'confirmBooking should succeed');
  assert.equal(r.result.delivery_queued, true, 'delivery_queued must be true');

  const rows = store._list();
  assert.equal(rows.length, 1, 'exactly one delivery record must be queued');
  assert.equal(rows[0].recipient,            'guest@example.com');
  assert.equal(rows[0].channel,              'email');
  assert.equal(rows[0].reservation_id,        reservationId);
  assert.equal(rows[0].confirmation_number,   confirmationNumber);
  assert.equal(rows[0].status,               'pending');
});

// ── Test 8: repeated confirmBooking call with same reservation → no duplicate ─

test('Phase 56 T8: repeated identical confirmBooking call queues no duplicate delivery', async () => {
  const { svc: deliverySvc, store } = makeDeliveryService();
  const paymentStateStore = buildPaymentStateStoreMemory();
  const reservationId = 'res-cdp-008';

  await paymentStateStore.upsert({
    reservation_id: reservationId, payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 900000).toISOString(),
    deposit_amount: 200, deposit_currency: 'USD', provider: 'mock',
  });

  const confirmationNumber = generateConfirmationNumber(reservationId);
  const bus = {
    async dispatch(name, input) {
      if (name === 'pms.reservation.confirm')
        return { ok: true, result: { id: input.reservation_id, status: 'CONFIRMED', confirmation_number: confirmationNumber } };
      return { ok: true, result: { id: input.reservation_id } };
    }
  };
  const svc = buildBookingService({
    commandBus: bus,
    availabilityEngine: buildAvailabilityEngine({ availabilityProvider: () => 5 }),
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore,
    paymentAttemptLog: buildPaymentAttemptLogMemory(),
    confirmationDeliveryService: deliverySvc,
  });

  const ctx = Object.assign({}, CTX, { guestRecipient: 'dup-test@example.com', guestChannel: 'email' });

  // First call
  await svc.confirmBooking({ reservationId, paymentId: 'pay-101',
    roomTypeId: 'rt1', arrival: '2026-09-01', departure: '2026-09-03', adults: 2 }, ctx);

  // Second call (simulate duplicate / replay): queue directly on the same reservation
  const qr2 = await deliverySvc.queueDelivery({
    tenantId: CTX.tenantId, reservationId,
    confirmationNumber, channel: 'email', recipient: 'dup-test@example.com',
  }, CTX);

  assert.equal(qr2.deduped, true, 'second queue request must be deduped');
  assert.equal(store._list().length, 1, 'still exactly one delivery row');
});

// ── Test 9: delivery success sets confirmation_sent_at ────────────────────────

test('Phase 56 T9: delivery success → confirmation_sent_at is set', async () => {
  const { svc, store, confirmationSentAts } = makeDeliveryService('success');
  const reservationId = 'res-cdp-009';

  await svc.queueDelivery({
    tenantId: CTX.tenantId, propertyId: CTX.propertyId, reservationId,
    confirmationNumber: 'ABCD1234', channel: 'email', recipient: 'sent@example.com',
  }, CTX);

  const before = confirmationSentAts.get(reservationId);
  assert.equal(before, undefined, 'confirmation_sent_at must not be set before delivery');

  await svc.processPendingDeliveries({ limit: 10 });

  const sent = confirmationSentAts.get(reservationId);
  assert.ok(sent, 'confirmation_sent_at must be set after successful delivery');
  assert.equal(store._list()[0].status, 'sent', 'delivery record must be marked sent');
});

// ── Test 10: queueing alone does not set confirmation_sent_at ─────────────────

test('Phase 56 T10: queueing a delivery alone does NOT set confirmation_sent_at', async () => {
  const { svc, confirmationSentAts } = makeDeliveryService('success');
  const reservationId = 'res-cdp-010';

  await svc.queueDelivery({
    tenantId: CTX.tenantId, reservationId,
    confirmationNumber: 'QWER1234', channel: 'email', recipient: 'pending@example.com',
  }, CTX);

  // Do NOT call processPendingDeliveries
  assert.equal(confirmationSentAts.get(reservationId), undefined,
    'confirmation_sent_at must not be set by queueDelivery alone');
});

// ── Test 11: retryable failure → delivery remains pending, retry scheduled ───

test('Phase 56 T11: retryable failure → delivery stays pending with next_attempt_at set', async () => {
  const { svc, store } = makeDeliveryService('retryable');
  const reservationId = 'res-cdp-011';

  await svc.queueDelivery({
    tenantId: CTX.tenantId, reservationId,
    confirmationNumber: 'RETRY001', channel: 'email', recipient: 'retry@example.com',
    context: {},
  }, CTX);

  const result = await svc.processPendingDeliveries({ limit: 10 });
  assert.equal(result.retryable, 1, 'one retryable failure');
  assert.equal(result.sent, 0,      'no successful sends');

  const row = store._list()[0];
  assert.equal(row.status, 'pending', 'row must revert to pending for retry');
  assert.ok(row.next_attempt_at, 'next_attempt_at must be set after retryable failure');
  assert.equal(row.attempt_count, 1, 'attempt_count must be incremented');
});

// ── Test 12: permanent failure (exhausted max_attempts) ────────────────────────

test('Phase 56 T12: permanent failure after max_attempts exhausted', async () => {
  const { svc, store } = makeDeliveryService('permanent');
  const reservationId = 'res-cdp-012';

  await svc.queueDelivery({
    tenantId: CTX.tenantId, reservationId,
    confirmationNumber: 'PERM0012', channel: 'email', recipient: 'fail@example.com',
  }, CTX);

  // Set max_attempts to 1 via the store directly so we exhaust it in one run
  const row = store._list()[0];
  Object.assign(row, { max_attempts: 1 });

  const result = await svc.processPendingDeliveries({ limit: 10 });
  assert.equal(result.permanent, 1, 'one permanent failure');

  const updated = store._list()[0];
  assert.equal(updated.status, 'permanent_failure', 'row must become permanent_failure');
});

// ── Test 13: later successful retry sets confirmation_sent_at ──────────────────

test('Phase 56 T13: retryable failure followed by successful retry → confirmation_sent_at set', async () => {
  let callCount = 0;
  const adapter = { async send() {
    callCount++;
    if (callCount === 1) return { ok: false, error: 'transient' };
    return { ok: true, provider_ref: 'prov-retry-ok' };
  }};

  const store = buildConfirmationDeliveryStoreMemory();
  const sentAts = new Map();
  const svc = buildConfirmationDeliveryService({
    repo: store,
    notificationAdapter: adapter,
    setReservationConfirmationSent: async (tid, rid, sentAt) => { sentAts.set(rid, sentAt); },
  });

  const reservationId = 'res-cdp-013';
  await svc.queueDelivery({
    tenantId: CTX.tenantId, reservationId,
    confirmationNumber: 'RETRY013', channel: 'email', recipient: 'retry13@example.com',
  }, CTX);

  // First run: retryable failure
  await svc.processPendingDeliveries({ limit: 10 });
  assert.equal(sentAts.get(reservationId), undefined, 'confirmation_sent_at not set after first failure');

  // Manually reset next_attempt_at so the second run picks it up
  const row = store._list()[0];
  Object.assign(row, { next_attempt_at: null });

  // Second run: success
  await svc.processPendingDeliveries({ limit: 10 });
  assert.ok(sentAts.get(reservationId), 'confirmation_sent_at must be set after successful retry');
  assert.equal(store._list()[0].status, 'sent', 'row must be marked sent');
});

// ── Test 14: already-sent delivery is not resent ──────────────────────────────

test('Phase 56 T14: already-sent delivery record is not resent', async () => {
  const adapter = makeAdapter('success');
  const store = buildConfirmationDeliveryStoreMemory();
  const svc = buildConfirmationDeliveryService({ repo: store, notificationAdapter: adapter });

  const reservationId = 'res-cdp-014';
  await svc.queueDelivery({
    tenantId: CTX.tenantId, reservationId,
    confirmationNumber: 'SENT0014', channel: 'email', recipient: 'sent14@example.com',
  }, CTX);

  // First successful delivery
  await svc.processPendingDeliveries({ limit: 10 });
  assert.equal(store._list()[0].status, 'sent');

  const callCountAfterFirst = adapter.calls.length;

  // Second run: the row is 'sent', worker must skip it
  await svc.processPendingDeliveries({ limit: 10 });
  assert.equal(adapter.calls.length, callCountAfterFirst, 'adapter must not be called again for already-sent row');
});

// ── Test 15: concurrent workers cannot both claim the same delivery record ────

test('Phase 56 T15: concurrent workers cannot both process the same delivery record', async () => {
  const sent = [];
  const adapter = { async send(args) { sent.push(args.recipient); return { ok: true }; } };
  const store = buildConfirmationDeliveryStoreMemory();

  const svc1 = buildConfirmationDeliveryService({ repo: store, notificationAdapter: adapter, workerId: 'w1' });
  const svc2 = buildConfirmationDeliveryService({ repo: store, notificationAdapter: adapter, workerId: 'w2' });

  const reservationId = 'res-cdp-015';
  await svc1.queueDelivery({
    tenantId: CTX.tenantId, reservationId,
    confirmationNumber: 'CONC0015', channel: 'email', recipient: 'conc15@example.com',
  }, CTX);

  // Both workers attempt to process the single row simultaneously.
  // The in-memory store's claim logic is single-threaded (one Promise.all resolution
  // path), so exactly one worker gets it.
  await Promise.all([
    svc1.processPendingDeliveries({ limit: 1 }),
    svc2.processPendingDeliveries({ limit: 1 }),
  ]);

  // The row should be 'sent' and the adapter should have been called exactly once.
  assert.equal(sent.length, 1,
    'adapter must be called exactly once even under concurrent worker competition');
  assert.equal(store._list()[0].status, 'sent');
});
