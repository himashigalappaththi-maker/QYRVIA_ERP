'use strict';

/**
 * Phase 69A (instruction 048 Section 17) — Booking.com TEST-property safety
 * guard. Pure function, no DB, no network — see
 * src/channel-manager/adapters/bookingcom/testPropertyGuard.js's own header
 * for the full explanation of what each check maps to in existing QYRVIA
 * configuration (no schema migration required).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assertBookingComTestOperationAllowed, PERMITTED_TEST_OPERATIONS } = require('../src/channel-manager/adapters/bookingcom/testPropertyGuard');

function validInput(overrides) {
  return Object.assign({
    connectionStatus: 'sandbox',
    credentialEnvironment: 'TEST',
    mappingCredentialsRef: 'cred-test-1',
    resolvedCredentialsRef: 'cred-test-1',
    operation: 'AVAILABILITY_INVENTORY_PUSH',
    liveGates: { ariBookingComLive: false, ariOutboxDispatchEnabled: false, ariOutboxWorkerEnabled: false, ariOutboxHttpEnabled: false, channelHttpEnabled: false }
  }, overrides);
}

test('PERMITTED_TEST_OPERATIONS is exactly [AVAILABILITY_INVENTORY_PUSH] in this phase', () => {
  assert.deepEqual(PERMITTED_TEST_OPERATIONS, ['AVAILABILITY_INVENTORY_PUSH']);
});

test('allows a fully-proven TEST configuration', () => {
  const r = assertBookingComTestOperationAllowed(validInput());
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});

test('refuses when connection status is not sandbox (e.g. live, configured, not_configured)', () => {
  for (const status of ['live', 'configured', 'not_configured', 'error', 'paused', null, undefined]) {
    const r = assertBookingComTestOperationAllowed(validInput({ connectionStatus: status }));
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'CONNECTION_ENVIRONMENT_NOT_TEST');
  }
});

test('refuses when the credential is not explicitly TEST-classified', () => {
  for (const env of ['PRODUCTION', null, undefined, 'test', 'Test']) {
    const r = assertBookingComTestOperationAllowed(validInput({ credentialEnvironment: env }));
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'CREDENTIAL_NOT_TEST_CLASSIFIED');
  }
});

test('refuses when the mapping has no credentials_ref at all', () => {
  const r = assertBookingComTestOperationAllowed(validInput({ mappingCredentialsRef: null }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'MAPPING_MISSING_CREDENTIALS_REF');
});

test('refuses when the mapping\'s credentials_ref does not match the credential actually being used', () => {
  const r = assertBookingComTestOperationAllowed(validInput({ mappingCredentialsRef: 'cred-test-1', resolvedCredentialsRef: 'cred-DIFFERENT' }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'MAPPING_CREDENTIALS_REF_MISMATCH');
});

test('refuses an operation outside the permitted one-shot test set', () => {
  for (const op of ['RATE_UPDATE', 'RESTRICTION_UPDATE', 'RESERVATION_PUSH', null, undefined, '']) {
    const r = assertBookingComTestOperationAllowed(validInput({ operation: op }));
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'OPERATION_NOT_PERMITTED_FOR_TEST');
  }
});

test('refuses when ANY live/production gate reads true, even with everything else proven TEST', () => {
  for (const gate of ['ariBookingComLive', 'ariOutboxDispatchEnabled', 'ariOutboxWorkerEnabled', 'ariOutboxHttpEnabled', 'channelHttpEnabled']) {
    const liveGates = { ariBookingComLive: false, ariOutboxDispatchEnabled: false, ariOutboxWorkerEnabled: false, ariOutboxHttpEnabled: false, channelHttpEnabled: false };
    liveGates[gate] = true;
    const r = assertBookingComTestOperationAllowed(validInput({ liveGates }));
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'PROVIDER_LIVE_MODE_SELECTED:' + gate);
  }
});

test('checks are evaluated in a fixed, deterministic order — connection environment is checked before credential/mapping', () => {
  // Multiple things wrong at once: the FIRST failing check in the documented
  // order must be the one reported, so callers get a single, unambiguous
  // reason rather than a nondeterministic pick.
  const r = assertBookingComTestOperationAllowed({
    connectionStatus: 'live', credentialEnvironment: null, mappingCredentialsRef: null,
    resolvedCredentialsRef: null, operation: 'NOT_PERMITTED', liveGates: { ariBookingComLive: true }
  });
  assert.equal(r.reason, 'CONNECTION_ENVIRONMENT_NOT_TEST');
});

test('never guesses classification from an ID\'s shape — a numeric-looking mapping alone proves nothing without explicit TEST markers', () => {
  const r = assertBookingComTestOperationAllowed(validInput({
    connectionStatus: null, credentialEnvironment: null,
    // even though this LOOKS like a real Booking.com numeric hotel/room id, that alone is never sufficient
    mappingCredentialsRef: '123456'
  }));
  assert.equal(r.allowed, false);
});

test('is a pure function: identical input always yields identical output, no hidden state across calls', () => {
  const input = validInput();
  const a = assertBookingComTestOperationAllowed(input);
  const b = assertBookingComTestOperationAllowed(input);
  assert.deepEqual(a, b);
});
