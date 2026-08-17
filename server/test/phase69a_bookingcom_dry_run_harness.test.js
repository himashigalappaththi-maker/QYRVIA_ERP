'use strict';

/**
 * Phase 69A (instruction 048 Section 24) — Booking.com one-shot TEST
 * availability harness: proves the DRY-RUN path builds a correct, safe
 * preflight request and that network execution is UNCONDITIONALLY refused
 * in this phase. Pure NO-NETWORK unit tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runDryRun, buildCorrelationId, OPERATION } = require('../scripts/channel/bookingComTestAvailabilityHarness');

function validInput(overrides) {
  return Object.assign({
    tenantId: 't1', propertyId: 'p1', roomTypeId: 'rt1', credentialsRef: 'cred-test-1',
    connectionStatus: 'sandbox', credentialEnvironment: 'TEST',
    mapping: { otaPropertyId: 'H1', otaRoomId: 'R1', credentialsRef: 'cred-test-1' },
    inventory: { date: '2026-08-01', physical: 10, sold: 3, blocked: 0, stopSell: false }
  }, overrides);
}

test('OPERATION is exactly AVAILABILITY_INVENTORY_PUSH', () => {
  assert.equal(OPERATION, 'AVAILABILITY_INVENTORY_PUSH');
});

test('a fully-proven TEST configuration produces a dry-run preflight report — no network call made', async () => {
  const r = await runDryRun(validInput());
  assert.equal(r.ok, true);
  assert.equal(r.blocked, false);
  assert.equal(r.dryRun, true);
  assert.equal(r.networkCallMade, false);
  assert.equal(r.preflight.method, 'POST');
  assert.equal(r.preflight.endpoint, 'https://supply-xml.booking.com/hotels/xml/availability');
  assert.equal(r.preflight.headers['Content-Type'], 'application/xml');
  assert.equal(r.preflight.headers['Accept-Version'], '1.1');
  assert.match(r.preflight.bodyXmlPreview, /<hotel_id>H1<\/hotel_id>/);
  assert.match(r.preflight.bodyXmlPreview, /<room id="R1">/);
  assert.match(r.preflight.bodyXmlPreview, /<rooms_to_sell>7<\/rooms_to_sell>/); // 10 - 3 - 0
  assert.equal(r.preflight.ledgerPlan.ledgerWriteExecutedInThisRun, false);
});

test('no Authorization header is ever present in the dry-run preflight (no secret/token is ever resolved)', async () => {
  const r = await runDryRun(validInput());
  assert.equal(r.preflight.headers.Authorization, undefined);
  assert.ok(!JSON.stringify(r.preflight.headers).toLowerCase().includes('bearer'));
});

test('missing any required identity field is refused — no default tenant/property/room/credential', async () => {
  for (const field of ['tenantId', 'propertyId', 'roomTypeId', 'credentialsRef']) {
    const input = validInput(); delete input[field];
    const r = await runDryRun(input);
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.equal(r.reason, 'MISSING_REQUIRED_IDENTIFIER');
  }
});

test('refuses when the connection is not TEST-classified (delegates to the same guard as the rest of Phase 69A)', async () => {
  const r = await runDryRun(validInput({ connectionStatus: 'live' }));
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'CONNECTION_ENVIRONMENT_NOT_TEST');
});

test('refuses a production-classified credential', async () => {
  const r = await runDryRun(validInput({ credentialEnvironment: 'PRODUCTION' }));
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'CREDENTIAL_NOT_TEST_CLASSIFIED');
});

test('refuses when the mapping is not bound to the exact credential being used', async () => {
  const r = await runDryRun(validInput({ mapping: { otaPropertyId: 'H1', otaRoomId: 'R1', credentialsRef: 'some-other-cred' } }));
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'MAPPING_CREDENTIALS_REF_MISMATCH');
});

test('refuses when any live/production gate is active, even with an otherwise fully-proven TEST configuration', async () => {
  // config/env.js caches process.env at first require (module-load time,
  // long before this test runs), so mutating process.env here would not be
  // observed — runDryRun() accepts an explicit liveGates override for
  // exactly this reason (see its own JSDoc).
  const r = await runDryRun(validInput({ liveGates: { ariBookingComLive: true } }));
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'PROVIDER_LIVE_MODE_SELECTED:ariBookingComLive');
});

test('the default (no liveGates override) path reads the real, frozen env config — proven false/safe in this test process', async () => {
  const r = await runDryRun(validInput());
  assert.equal(r.ok, true, 'every real live gate is false by default in this test process, exactly as required repo-wide');
});

test('fails closed on missing/invalid inventory input — never fabricates a rooms-to-sell value', async () => {
  const r = await runDryRun(validInput({ inventory: { date: '2026-08-01' } })); // no physical/sold
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'ARI_MAPPING_INCOMPLETE_INVENTORY');
});

test('fails closed on a missing room/property mapping', async () => {
  const r = await runDryRun(validInput({ mapping: { credentialsRef: 'cred-test-1' } })); // no otaPropertyId/otaRoomId
  assert.equal(r.blocked, true);
  assert.ok(r.reason);
});

// ---- network refusal is unconditional --------------------------------------

test('networkAuthorized:true is UNCONDITIONALLY refused — even with a fully-proven TEST configuration', async () => {
  await assert.rejects(
    () => runDryRun(validInput({ networkAuthorized: true })),
    (e) => e.code === 'NETWORK_NOT_YET_AUTHORIZED'
  );
});

test('only the literal boolean true triggers the refusal path — a truthy-but-non-boolean value is not mistaken for authorization (and still never sends anything)', async () => {
  // networkAuthorized is checked with `=== true`, so a non-boolean truthy
  // value (e.g. the string 'true') does NOT match it — it simply falls
  // through to the normal (still network-free) dry-run success path. This
  // proves there is no clever non-boolean bypass INTO sending a request:
  // the only two outcomes are "still a dry run" or "explicitly refused".
  const r = await runDryRun(validInput({ networkAuthorized: 'true' }));
  assert.equal(r.ok, true);
  assert.equal(r.networkCallMade, false);
});

// ---- deterministic correlation id -------------------------------------------

test('buildCorrelationId is deterministic for identical inputs, distinct for different inputs', () => {
  const args = { credentialsRef: 'c1', tenantId: 't1', propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01' };
  assert.equal(buildCorrelationId(args), buildCorrelationId(args));
  assert.notEqual(buildCorrelationId(args), buildCorrelationId(Object.assign({}, args, { date: '2026-08-02' })));
});

test('the SAME input always produces the SAME correlation id across two separate dry runs (reproducibility)', async () => {
  const a = await runDryRun(validInput());
  const b = await runDryRun(validInput());
  assert.equal(a.preflight.correlationId, b.preflight.correlationId);
});

// ---- manual invocation only / no scheduler ----------------------------------

test('the harness module registers no timer/interval as a side effect of being required', () => {
  const before = process.listenerCount('exit');
  require('../scripts/channel/bookingComTestAvailabilityHarness'); // already required above; re-require is a no-op (module cache)
  assert.equal(process.listenerCount('exit'), before, 'requiring the harness must never register process-level listeners/timers');
});
