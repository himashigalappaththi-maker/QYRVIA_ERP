'use strict';

/**
 * Phase 54 D10 — Pure unit tests for bookingStateMachine.js.
 * Tests Items 2-6 (state machine logic).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  getTransition,
  isValidTransition,
  getAllowedTriggers,
  BOOKING_STATES,
  TRANSITIONS,
} = require('../src/booking-engine/bookingStateMachine');

// 1. draft -> initiate_payment -> pending_payment
test('stateMachine: getTransition(draft, initiate_payment) returns to: pending_payment', () => {
  const t = getTransition('draft', 'initiate_payment');
  assert.ok(t, 'transition should exist');
  assert.equal(t.to, 'pending_payment');
  assert.equal(t.from, 'draft');
  assert.equal(t.trigger, 'initiate_payment');
  assert.equal(t.requiresInventoryCheck, true);
  assert.equal(t.requiresPaymentCall, true);
});

// 2. pending_payment -> payment_confirmed -> confirmed
test('stateMachine: getTransition(pending_payment, payment_confirmed) returns to: confirmed', () => {
  const t = getTransition('pending_payment', 'payment_confirmed');
  assert.ok(t, 'transition should exist');
  assert.equal(t.to, 'confirmed');
  assert.equal(t.requiresInventoryCheck, true);
  assert.equal(t.requiresPaymentCall, false);
});

// 3. pending_payment -> hold_expired -> cancelled
test('stateMachine: getTransition(pending_payment, hold_expired) returns to: cancelled', () => {
  const t = getTransition('pending_payment', 'hold_expired');
  assert.ok(t, 'transition should exist');
  assert.equal(t.to, 'cancelled');
  assert.equal(t.requiresInventoryCheck, false);
  assert.equal(t.requiresPaymentCall, false);
});

// 4. confirmed -> cancel -> cancelled (requires payment call for refund)
test('stateMachine: getTransition(confirmed, cancel) has requiresPaymentCall: true', () => {
  const t = getTransition('confirmed', 'cancel');
  assert.ok(t, 'transition should exist');
  assert.equal(t.to, 'cancelled');
  assert.equal(t.requiresPaymentCall, true);
});

// 5. draft -> payment_confirmed is NOT a direct transition
test('stateMachine: isValidTransition(draft, payment_confirmed) returns false', () => {
  assert.equal(isValidTransition('draft', 'payment_confirmed'), false);
});

// 6. getAllowedTriggers for pending_payment returns all valid triggers
test('stateMachine: getAllowedTriggers(pending_payment) returns all expected triggers', () => {
  const triggers = getAllowedTriggers('pending_payment');
  assert.ok(Array.isArray(triggers));
  assert.ok(triggers.includes('payment_confirmed'), 'should include payment_confirmed');
  assert.ok(triggers.includes('payment_failed'),    'should include payment_failed');
  assert.ok(triggers.includes('hold_expired'),      'should include hold_expired');
  assert.equal(triggers.length, 3, 'exactly 3 triggers for pending_payment');
});

// 7. unknown state -> getTransition returns null gracefully
test('stateMachine: getTransition(unknown, foo) returns null gracefully', () => {
  const t = getTransition('unknown', 'foo');
  assert.equal(t, null);
});

// 8. BOOKING_STATES constants exported correctly
test('stateMachine: BOOKING_STATES exports correct constants', () => {
  assert.equal(BOOKING_STATES.DRAFT, 'draft');
  assert.equal(BOOKING_STATES.PENDING_PAYMENT, 'pending_payment');
  assert.equal(BOOKING_STATES.CONFIRMED, 'confirmed');
  assert.equal(BOOKING_STATES.PAYMENT_FAILED, 'payment_failed');
  assert.equal(BOOKING_STATES.CANCELLED, 'cancelled');
});

// 9. TRANSITIONS array has all expected entries
test('stateMachine: TRANSITIONS array is frozen and contains all expected transitions', () => {
  assert.ok(Array.isArray(TRANSITIONS));
  // Expect at least: draft->pending_payment, pending_payment->confirmed, pending_payment->payment_failed,
  //                  pending_payment->cancelled, draft->cancelled, payment_failed->cancelled, confirmed->cancelled
  assert.ok(TRANSITIONS.length >= 7, 'should have at least 7 transitions');
  assert.ok(Object.isFrozen(TRANSITIONS), 'TRANSITIONS should be frozen');
});

// 10. isValidTransition for valid transitions returns true
test('stateMachine: isValidTransition returns true for all defined transitions', () => {
  for (const t of TRANSITIONS) {
    assert.equal(isValidTransition(t.from, t.trigger), true,
      `Expected isValidTransition(${t.from}, ${t.trigger}) to be true`);
  }
});

// 11. payment_failed -> cancel -> cancelled
test('stateMachine: getTransition(payment_failed, cancel) returns to: cancelled', () => {
  const t = getTransition('payment_failed', 'cancel');
  assert.ok(t, 'transition should exist');
  assert.equal(t.to, 'cancelled');
  assert.equal(t.requiresPaymentCall, false);
});

// 12. pending_payment -> payment_failed -> payment_failed state
test('stateMachine: getTransition(pending_payment, payment_failed) returns to: payment_failed', () => {
  const t = getTransition('pending_payment', 'payment_failed');
  assert.ok(t, 'transition should exist');
  assert.equal(t.to, 'payment_failed');
});

// 13. getAllowedTriggers for confirmed
test('stateMachine: getAllowedTriggers(confirmed) returns [cancel]', () => {
  const triggers = getAllowedTriggers('confirmed');
  assert.deepEqual(triggers, ['cancel']);
});

// 14. getAllowedTriggers for unknown state returns empty array
test('stateMachine: getAllowedTriggers(nonexistent) returns empty array', () => {
  const triggers = getAllowedTriggers('nonexistent');
  assert.ok(Array.isArray(triggers));
  assert.equal(triggers.length, 0);
});
