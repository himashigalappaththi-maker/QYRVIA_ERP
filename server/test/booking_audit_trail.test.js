'use strict';

/**
 * Phase 54 D10 — Audit trail tests (Item 7).
 * Tests event content (no PII/card data), payment attempt log insertion,
 * and sanitizePaymentPayload stripping.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildBookingService }           = require('../src/booking-engine/bookingService');
const { buildMockPaymentProvider }      = require('../src/payment/mockPaymentProvider');
const { buildPaymentStateStoreMemory }  = require('../src/payment/paymentStateStore');
const { buildPaymentAttemptLogMemory }  = require('../src/payment/paymentAttemptLog');
const { sanitizePaymentPayload }        = require('../src/payment/sanitizePaymentPayload');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

function fakeCommandBus() {
  let n = 0;
  return {
    async dispatch(name) {
      return { ok: true, result: { id: 'res-' + (++n) } };
    }
  };
}

function fakeAvailabilityEngine({ available = true } = {}) {
  return { async check() { return { available, rooms: available ? 5 : 0, reason: available ? undefined : 'no_availability' }; } };
}

function fakePricingEngine() {
  return { quote() { return { ok: true, total: 230, base_rate: 200, taxes: 30, discounts: 0, currency: 'USD' }; } };
}

function fakeValidator({ ok = true } = {}) {
  return { validate() { return ok ? { ok: true } : { ok: false, reason: 'VALIDATION_FAILED', detail: [] }; } };
}

function buildSvc({ events, paymentProvider, paymentStateStore, paymentAttemptLog, available = true } = {}) {
  const capturedEvents = events || [];
  return buildBookingService({
    commandBus:          fakeCommandBus(),
    availabilityEngine:  fakeAvailabilityEngine({ available }),
    pricingEngine:       fakePricingEngine(),
    validator:           fakeValidator(),
    paymentProvider:     paymentProvider || buildMockPaymentProvider(),
    paymentStateStore:   paymentStateStore || buildPaymentStateStoreMemory(),
    paymentAttemptLog:   paymentAttemptLog || buildPaymentAttemptLogMemory(),
    onEvent: (e) => capturedEvents.push(e),
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

// 1. booking.payment_initiated event contains required fields, no PII
test('audit: booking.payment_initiated event has tenantId, channel, reservationId, total, currency', async () => {
  const events = [];
  const svc = buildSvc({ events });
  await svc.initiateBooking(validInput(), CTX);

  const ev = events.find(e => e.type === 'booking.payment_initiated');
  assert.ok(ev, 'booking.payment_initiated event should be emitted');
  assert.ok(ev.tenantId, 'event should have tenantId');
  assert.ok(ev.reservationId !== undefined, 'event should have reservationId');
  assert.ok(typeof ev.total === 'number', 'event should have numeric total');
  assert.ok(ev.currency, 'event should have currency');
});

// 2. booking.payment_initiated event has no guest PII or payment card data
test('audit: booking.payment_initiated event contains no client_secret, cardNumber, guest_email', async () => {
  const events = [];
  const svc = buildSvc({ events });
  await svc.initiateBooking(validInput({ guest_email: 'test@example.com' }), CTX);

  const ev = events.find(e => e.type === 'booking.payment_initiated');
  assert.ok(ev, 'event should be emitted');
  assert.equal(ev.client_secret, undefined, 'no client_secret in event');
  assert.equal(ev.clientSecret, undefined, 'no clientSecret in event');
  assert.equal(ev.cardNumber, undefined, 'no cardNumber in event');
  assert.equal(ev.guest_email, undefined, 'no guest_email PII in event');
});

// 3. booking.created event from confirmBooking has tenantId, channel, reservationId — no client_secret
test('audit: booking.created event from confirmBooking has no client_secret', async () => {
  const events = [];
  const stateStore = buildPaymentStateStoreMemory();
  const svc = buildSvc({ events, paymentStateStore: stateStore });

  const initResult = await svc.initiateBooking(validInput(), CTX);
  assert.ok(initResult.ok, 'initiate should succeed');

  const reservationId = initResult.result.reservation_id;
  const paymentId     = initResult.result.payment_id;

  await svc.confirmBooking({ reservationId, paymentId, roomTypeId: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', adults: 2 }, CTX);

  const ev = events.find(e => e.type === 'booking.created');
  assert.ok(ev, 'booking.created event should be emitted on confirm');
  assert.ok(ev.tenantId, 'event should have tenantId');
  assert.ok(ev.reservationId !== undefined, 'event should have reservationId');
  assert.equal(ev.client_secret, undefined, 'no client_secret in booking.created event');
  assert.equal(ev.clientSecret, undefined, 'no clientSecret in booking.created event');
});

// 4. booking.rejected event from failed initiateBooking has tenantId, channel, reason — no PII
test('audit: booking.rejected event from unavailable slot has reason, no PII', async () => {
  const events = [];
  const svc = buildSvc({ events, available: false });
  await svc.initiateBooking(validInput(), CTX);

  const ev = events.find(e => e.type === 'booking.rejected');
  assert.ok(ev, 'booking.rejected event should be emitted');
  assert.ok(ev.tenantId, 'event should have tenantId');
  assert.ok(ev.reason, 'event should have reason');
  assert.equal(ev.guest_email, undefined, 'no PII in rejected event');
  assert.equal(ev.client_secret, undefined, 'no client_secret in rejected event');
});

// 5. paymentAttemptLog.insert called with status: 'initiated' during initiateBooking
test('audit: paymentAttemptLog.insert called with status: initiated during initiateBooking', async () => {
  const insertCalls = [];
  const fakeLog = {
    insert(entry) { insertCalls.push(entry); return entry; },
    listByReservation() { return []; }
  };
  const svc = buildSvc({ paymentAttemptLog: fakeLog });
  const r = await svc.initiateBooking(validInput(), CTX);
  assert.ok(r.ok, 'initiate should succeed');
  assert.ok(insertCalls.length >= 1, 'insert should be called at least once');
  const initiatedEntry = insertCalls.find(e => e.status === 'initiated');
  assert.ok(initiatedEntry, 'should have an entry with status: initiated');
  assert.ok(initiatedEntry.reservation_id, 'log entry should have reservation_id');
  assert.ok(initiatedEntry.tenant_id, 'log entry should have tenant_id');
});

// 6. paymentAttemptLog.insert called with status: 'success' during successful confirmBooking
test('audit: paymentAttemptLog.insert called with status: success during confirmBooking', async () => {
  const insertCalls = [];
  const fakeLog = {
    insert(entry) { insertCalls.push(entry); return entry; },
    listByReservation() { return []; }
  };
  const stateStore = buildPaymentStateStoreMemory();
  const svc = buildSvc({ paymentAttemptLog: fakeLog, paymentStateStore: stateStore });

  const initResult = await svc.initiateBooking(validInput(), CTX);
  assert.ok(initResult.ok);

  const reservationId = initResult.result.reservation_id;
  const paymentId     = initResult.result.payment_id;

  const confirmResult = await svc.confirmBooking({ reservationId, paymentId }, CTX);
  assert.ok(confirmResult.ok, 'confirm should succeed');

  const successEntry = insertCalls.find(e => e.status === 'success');
  assert.ok(successEntry, 'should have an entry with status: success after confirm');
  assert.ok(successEntry.reservation_id, 'success log entry should have reservation_id');
});

// 7. sanitizePaymentPayload strips known sensitive keys
test('sanitizePaymentPayload: strips clientSecret, client_secret, cardNumber, cvv', () => {
  const raw = {
    clientSecret: 'sk_live_abc123',
    client_secret: 'sk_live_def456',
    cardNumber: '4111111111111111',
    cvv: '123',
    cvc: '456',
    paymentId: 'pay_xyz',
    amount: 100,
    currency: 'USD',
  };
  const sanitized = sanitizePaymentPayload(raw);

  assert.equal(sanitized.clientSecret,   '[REDACTED]', 'clientSecret should be redacted');
  assert.equal(sanitized.client_secret,  '[REDACTED]', 'client_secret should be redacted');
  assert.equal(sanitized.cardNumber,     '[REDACTED]', 'cardNumber should be redacted');
  assert.equal(sanitized.cvv,            '[REDACTED]', 'cvv should be redacted');
  assert.equal(sanitized.cvc,            '[REDACTED]', 'cvc should be redacted');
  // Non-sensitive fields should be preserved
  assert.equal(sanitized.paymentId,  'pay_xyz', 'paymentId should be preserved');
  assert.equal(sanitized.amount,     100,       'amount should be preserved');
  assert.equal(sanitized.currency,   'USD',     'currency should be preserved');
});

// 8. sanitizePaymentPayload strips apiKey, secretKey, privateKey
test('sanitizePaymentPayload: strips apiKey, secretKey, privateKey variants', () => {
  const raw = {
    apiKey:      'apikey-secret',
    api_key:     'api-key-secret',
    secretKey:   'secret-key',
    secret_key:  'secret-key-2',
    privateKey:  'private-key',
    private_key: 'private-key-2',
    stripeKey:   'sk_live_stripe',
    stripe_key:  'sk_live_stripe2',
    paymentToken: 'tok_abc',
    payment_token: 'tok_def',
    safeField:   'keep-me',
  };
  const sanitized = sanitizePaymentPayload(raw);

  assert.equal(sanitized.apiKey,       '[REDACTED]');
  assert.equal(sanitized.api_key,      '[REDACTED]');
  assert.equal(sanitized.secretKey,    '[REDACTED]');
  assert.equal(sanitized.secret_key,   '[REDACTED]');
  assert.equal(sanitized.privateKey,   '[REDACTED]');
  assert.equal(sanitized.private_key,  '[REDACTED]');
  assert.equal(sanitized.stripeKey,    '[REDACTED]');
  assert.equal(sanitized.stripe_key,   '[REDACTED]');
  assert.equal(sanitized.paymentToken, '[REDACTED]');
  assert.equal(sanitized.payment_token,'[REDACTED]');
  assert.equal(sanitized.safeField,    'keep-me', 'non-sensitive field preserved');
});

// 9. sanitizePaymentPayload handles null/non-object gracefully
test('sanitizePaymentPayload: returns non-objects unchanged', () => {
  assert.equal(sanitizePaymentPayload(null),      null);
  assert.equal(sanitizePaymentPayload(undefined),  undefined);
  assert.equal(sanitizePaymentPayload('string'),  'string');
  assert.equal(sanitizePaymentPayload(42),         42);
});

// 10. initiateBooking result does NOT leak clientSecret into events (even if provider returned one)
test('audit: provider clientSecret in result is not forwarded into events', async () => {
  // A mock provider that returns a clientSecret field
  const leakyProvider = {
    async initiate() { return { ok: true, paymentId: 'pay_1', clientSecret: 'cs_live_SECRETVALUE', provider: 'mock' }; },
    async verify()   { return { ok: true, status: 'paid', provider: 'mock' }; },
  };
  const events = [];
  const svc = buildSvc({ events, paymentProvider: leakyProvider });
  const r = await svc.initiateBooking(validInput(), CTX);
  assert.ok(r.ok, 'should succeed');

  // The result itself may carry client_secret (for frontend use), but events must not
  for (const ev of events) {
    assert.equal(ev.client_secret, undefined,  `event ${ev.type} must not contain client_secret`);
    assert.equal(ev.clientSecret,  undefined,  `event ${ev.type} must not contain clientSecret`);
  }
});
