'use strict';

/**
 * Phase 55 — Confirmation number generation tests.
 * Verifies the generator function and that confirmBooking returns
 * confirmation_number in its result. confirmation_sent_at is NOT set
 * (no notification transport wired) — this is verified explicitly.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { generateConfirmationNumber }   = require('../src/services/pms/confirmationNumber');
const { buildBookingService }          = require('../src/booking-engine/bookingService');
const { buildMockPaymentProvider }     = require('../src/payment/mockPaymentProvider');
const { buildPaymentStateStoreMemory } = require('../src/payment/paymentStateStore');
const { buildPaymentAttemptLogMemory } = require('../src/payment/paymentAttemptLog');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

// ── 1. generateConfirmationNumber returns 8-char uppercase hex ───────────────

test('generateConfirmationNumber: valid UUID → 8-char uppercase hex string', () => {
  const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const cn = generateConfirmationNumber(uuid);
  assert.ok(cn, 'should return a non-null string');
  assert.equal(cn.length, 8, 'confirmation number should be 8 characters');
  assert.match(cn, /^[0-9A-F]{8}$/, 'should be uppercase hex');
  assert.equal(cn, 'A1B2C3D4');
});

// ── 2. generateConfirmationNumber: null input → null ─────────────────────────

test('generateConfirmationNumber: null input → null', () => {
  assert.equal(generateConfirmationNumber(null), null);
  assert.equal(generateConfirmationNumber(undefined), null);
  assert.equal(generateConfirmationNumber(''), null);
});

// ── 3. Two different UUIDs → different confirmation numbers ──────────────────

test('generateConfirmationNumber: two different UUIDs → different numbers', () => {
  const cn1 = generateConfirmationNumber('aaaaaaaa-0000-0000-0000-000000000000');
  const cn2 = generateConfirmationNumber('bbbbbbbb-0000-0000-0000-000000000000');
  assert.notEqual(cn1, cn2, 'different UUIDs should produce different confirmation numbers');
  assert.equal(cn1, 'AAAAAAAA');
  assert.equal(cn2, 'BBBBBBBB');
});

// ── 4. confirmBooking result includes confirmation_number ────────────────────

test('confirmBooking: result.confirmation_number is present when PMS confirm succeeds', async () => {
  const paymentStateStore = buildPaymentStateStoreMemory();
  const reservationId = 'cccccccc-dddd-eeee-ffff-000000000001';
  let confirmedReservationId = null;

  // Pre-seed payment state as pending_payment with a future hold
  await paymentStateStore.upsert({
    reservation_id: reservationId,
    payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 900000).toISOString(),
    deposit_amount: 200, deposit_currency: 'USD', provider: 'mock',
  });

  const svc = buildBookingService({
    commandBus: {
      async dispatch(name, input) {
        if (name === 'pms.reservation.confirm') {
          confirmedReservationId = input.reservation_id;
          // Simulate the command handler returning confirmation_number
          const cn = generateConfirmationNumber(input.reservation_id);
          return { ok: true, result: { id: input.reservation_id, status: 'CONFIRMED', confirmation_number: cn } };
        }
        return { ok: true, result: { id: input.reservation_id } };
      }
    },
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore,
    paymentAttemptLog: buildPaymentAttemptLogMemory(),
  });

  const r = await svc.confirmBooking({
    reservationId,
    paymentId: 'mock_pay_001',
    roomTypeId: 'rt1', arrival: '2026-09-01', departure: '2026-09-03', adults: 2,
  }, CTX);

  assert.equal(r.ok, true, 'confirmBooking should succeed');
  assert.equal(r.result.action, 'confirm');
  assert.ok(r.result.confirmation_number, 'confirmation_number should be in result');
  assert.match(r.result.confirmation_number, /^[0-9A-F]{8}$/, 'confirmation_number should be 8-char uppercase hex');
  assert.equal(confirmedReservationId, reservationId, 'PMS confirm dispatched with correct reservation_id');
});

// ── 5. confirmation_sent_at is not set (no notification transport) ───────────

test('confirmBooking: confirmation_sent_at is not set when no notification transport exists', async () => {
  const paymentStateStore = buildPaymentStateStoreMemory();
  const reservationId = 'dddddddd-0000-0000-0000-000000000001';
  let confirmedPayload = null;

  await paymentStateStore.upsert({
    reservation_id: reservationId,
    payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 900000).toISOString(),
    deposit_amount: 150, deposit_currency: 'USD', provider: 'mock',
  });

  const svc = buildBookingService({
    commandBus: {
      async dispatch(name, input) {
        if (name === 'pms.reservation.confirm') {
          confirmedPayload = input;
          const cn = generateConfirmationNumber(input.reservation_id);
          return { ok: true, result: { id: input.reservation_id, status: 'CONFIRMED', confirmation_number: cn } };
        }
        return { ok: true, result: { id: input.reservation_id } };
      }
    },
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore,
    paymentAttemptLog: buildPaymentAttemptLogMemory(),
  });

  const r = await svc.confirmBooking({
    reservationId, paymentId: 'mock_pay_002',
    roomTypeId: 'rt1', arrival: '2026-09-01', departure: '2026-09-03', adults: 2,
  }, CTX);

  assert.equal(r.ok, true);
  // confirmation_sent_at must NOT be set — no notification transport exists.
  // It is written only when an actual notification dispatch confirms delivery.
  assert.equal(r.result.confirmation_sent_at, undefined,
    'confirmation_sent_at must not be set when no notification transport exists');
});

// ── 6. Format validation: confirmation_number matches expected format ────────

test('generateConfirmationNumber: format is exactly 8 uppercase hex chars for any valid UUID', () => {
  const uuids = [
    '00000000-0000-0000-0000-000000000001',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '12345678-abcd-ef01-2345-6789abcdef01',
  ];
  for (const u of uuids) {
    const cn = generateConfirmationNumber(u);
    assert.match(cn, /^[0-9A-F]{8}$/, `UUID ${u} should produce an 8-char uppercase hex string`);
  }
});
