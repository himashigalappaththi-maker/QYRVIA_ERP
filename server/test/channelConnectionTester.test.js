'use strict';

/**
 * Phase 37 WI-2a - channel sandbox / test-connection readiness probe.
 * The probe is READ-ONLY and side-effect-free: readiness only, NO network, and
 * PRESENCE-only credential checks (the secret is never resolved or returned).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelConnectionTester } = require('../src/channel-manager/services/channelConnectionTester');
const { buildInProcessTransport, buildHttpTransport } = require('../src/channel-manager/transport/transport');
const { TransportOTAAdapter } = require('../src/channel-manager/adapters/framework/TransportOTAAdapter');
const { CredentialAuthStrategy } = require('../src/channel-manager/adapters/framework/AuthStrategy');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq' };

// Minimal channelManager double: only getAdapter is used by the tester.
function fakeCM(map) {
  return {
    getAdapter(channel) {
      if (!map[channel]) throw new Error('no adapter registered for channel ' + channel);
      return map[channel];
    }
  };
}

// 1. ready: internal in-process transport, no external auth required
test('WI-2a: in-process channel with no auth is ready', async () => {
  const adapter = new TransportOTAAdapter({ channel: 'QTCN', transport: buildInProcessTransport() });
  const tester = buildChannelConnectionTester({ channelManager: fakeCM({ QTCN: adapter }) });
  const r = await tester.test('QTCN', CTX);
  assert.equal(r.ready, true);
  assert.equal(r.mode, 'sandbox');
  assert.deepEqual(r.checks, { adapter: true, transport: { ok: true, kind: 'in-process' }, credentials: true });
  assert.equal(r.reason, undefined);
});

// 2. disabled HTTP transport => ready:false, and readiness uses health() ONLY:
//    no transport.send() and no network/fetch. Spies wrap the REAL HTTP transport
//    so the assertions bind to actual behavior, not a stub.
test('WI-2a: disabled HTTP transport reports not-ready via health() only (no send, no network)', async () => {
  let fetchCalls = 0, sendCalls = 0, healthCalls = 0;
  const spyFetch = async () => { fetchCalls += 1; return { ok: true, status: 200 }; };
  const real = buildHttpTransport({ enabled: false, fetchImpl: spyFetch });
  // Delegating wrapper: identical behavior, but counts send()/health() calls.
  const transport = {
    kind: real.kind,
    async health(...a) { healthCalls += 1; return real.health(...a); },
    async send(...a)   { sendCalls += 1; return real.send(...a); },
    async close(...a)  { return real.close(...a); }
  };
  const adapter = new TransportOTAAdapter({ channel: 'BOOKING_COM', transport, endpoint: 'https://example.test/ota' });
  const tester = buildChannelConnectionTester({ channelManager: fakeCM({ BOOKING_COM: adapter }) });

  const r = await tester.test('BOOKING_COM', CTX);

  // Result: still not-ready with the transport reason.
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'transport_unavailable');
  assert.equal(r.checks.transport.ok, false);
  assert.equal(r.checks.transport.kind, 'http');

  // Readiness uses health() ONLY - never send(), never the network.
  assert.equal(healthCalls, 1, 'readiness must probe via health()');
  assert.equal(sendCalls, 0, 'readiness must NOT call transport.send()');
  assert.equal(fetchCalls, 0, 'readiness must NOT touch the network');
});

// 3. fail closed: missing tenant context => not ready, no probe
test('WI-2a: missing tenantId fails closed (no probe)', async () => {
  const adapter = new TransportOTAAdapter({ channel: 'QTCN', transport: buildInProcessTransport() });
  const tester = buildChannelConnectionTester({ channelManager: fakeCM({ QTCN: adapter }) });
  const r = await tester.test('QTCN', { requestId: 'rq' }); // no tenantId
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'tenant_context_required');
  assert.equal(r.checks.adapter, false, 'no probe runs when tenant context is missing');
});

// 4. adapter not registered => adapter check fails
test('WI-2a: unregistered channel reports adapter_not_registered', async () => {
  const tester = buildChannelConnectionTester({ channelManager: fakeCM({}) });
  const r = await tester.test('EXPEDIA', CTX);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'adapter_not_registered');
  assert.equal(r.checks.adapter, false);
});

// 5. credentials missing: credential-backed adapter with no ref/provider => not ready
test('WI-2a: credential-backed channel with no credentials_ref is not ready', async () => {
  const auth = new CredentialAuthStrategy({}); // no credentialsRef, no provider => isValid() false
  const adapter = new TransportOTAAdapter({ channel: 'AGODA', transport: buildInProcessTransport(), auth });
  const tester = buildChannelConnectionTester({ channelManager: fakeCM({ AGODA: adapter }) });
  const r = await tester.test('AGODA', CTX);
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'credentials_missing');
  assert.equal(r.checks.credentials, false);
  assert.equal(r.checks.transport.ok, true, 'transport is fine; only credentials gate fails');
});

// 6. NO secret leakage: presence check never resolves or returns the secret
test('WI-2a: readiness NEVER resolves or leaks a secret', async () => {
  let getCalls = 0;
  const SECRET = 'SUPER_SECRET_API_KEY_should_never_appear';
  const spyProvider = { async get() { getCalls += 1; return { api_key: SECRET }; } };
  const auth = new CredentialAuthStrategy({ credentialsRef: 'ref-1', tenantId: 't1', secretProvider: spyProvider });
  const adapter = new TransportOTAAdapter({ channel: 'EXPEDIA', transport: buildInProcessTransport(), auth });
  const tester = buildChannelConnectionTester({ channelManager: fakeCM({ EXPEDIA: adapter }) });

  const r = await tester.test('EXPEDIA', CTX);
  assert.equal(r.ready, true, 'ref + provider present => credentials satisfied on presence alone');
  assert.equal(r.checks.credentials, true);
  assert.equal(getCalls, 0, 'presence check must NOT resolve the secret');
  assert.ok(!JSON.stringify(r).includes(SECRET), 'the secret value must never appear in the result');
});
