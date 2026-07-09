'use strict';

/**
 * Phase 37 WI-2b - POST /api/channel/test-connection controller/route tests.
 *
 * Exercises the readiness-only connection probe through the HTTP controller
 * (handlers built directly with an injected channelManager, mirroring
 * bookingRoute.test.js). Asserts the READ envelope, fail-closed tenant handling,
 * and that NO secret value appears in the JSON response.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildController } = require('../src/channel-manager/api/channel.controller');
const { build } = require('../src/channel-manager/api/channel.routes');
const { buildInProcessTransport, buildHttpTransport } = require('../src/channel-manager/transport/transport');
const { TransportOTAAdapter } = require('../src/channel-manager/adapters/framework/TransportOTAAdapter');
const { CredentialAuthStrategy } = require('../src/channel-manager/adapters/framework/AuthStrategy');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq' };

function fakeRes() {
  return { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
}

// Minimal channelManager double: only getAdapter is used by the tester.
function fakeCM(map) {
  return {
    getAdapter(channel) {
      if (!map[channel]) throw new Error('no adapter registered for channel ' + channel);
      return map[channel];
    }
  };
}

test('ready path: registered in-process adapter => 200 ok with data.ready true, sandbox, readiness_only', async () => {
  const adapter = new TransportOTAAdapter({ channel: 'QYRVIA_CONNECT', transport: buildInProcessTransport() });
  const c = buildController({ channelManager: fakeCM({ QYRVIA_CONNECT: adapter }) });
  const res = fakeRes();
  await c.testConnection({ ctx: CTX, body: { channel: 'QYRVIA_CONNECT' } }, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.ready, true);
  assert.equal(res._json.data.mode, 'sandbox');
  assert.equal(res._json.data.probe, 'readiness_only');
  assert.equal(res._json.data.channel, 'QYRVIA_CONNECT');
  assert.equal(res._json.data.reason, undefined, 'no reason when ready');
  assert.equal(res._json.requestId, 'rq');
  // Exactly the non-secret fields, nothing else.
  assert.deepEqual(Object.keys(res._json.data).sort(), ['channel', 'checks', 'mode', 'probe', 'ready']);
});

test('missing channel in body => 400 ok:false error channel_required', async () => {
  const c = buildController({ channelManager: fakeCM({}) });
  const res = fakeRes();
  await c.testConnection({ ctx: CTX, body: {} }, res, () => {});
  assert.equal(res._status, 400);
  assert.equal(res._json.ok, false);
  assert.equal(res._json.error, 'channel_required');
});

test('not-ready path: unregistered adapter => 200 data.ready false with reason', async () => {
  const c = buildController({ channelManager: fakeCM({}) });
  const res = fakeRes();
  await c.testConnection({ ctx: CTX, body: { channel: 'EXPEDIA' } }, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.ready, false);
  assert.equal(res._json.data.reason, 'adapter_not_registered');
  assert.equal(res._json.data.probe, 'readiness_only');
});

test('not-ready path: disabled HTTP transport => 200 data.ready false transport_unavailable (no network)', async () => {
  let fetchCalls = 0;
  const spyFetch = async () => { fetchCalls += 1; return { ok: true, status: 200 }; };
  const transport = buildHttpTransport({ enabled: false, fetchImpl: spyFetch });
  const adapter = new TransportOTAAdapter({ channel: 'BOOKING_COM', transport, endpoint: 'https://example.test/ota' });
  const c = buildController({ channelManager: fakeCM({ BOOKING_COM: adapter }) });
  const res = fakeRes();
  await c.testConnection({ ctx: CTX, body: { channel: 'BOOKING_COM' } }, res, () => {});
  assert.equal(res._status, 200);
  assert.equal(res._json.data.ready, false);
  assert.equal(res._json.data.reason, 'transport_unavailable');
  assert.equal(res._json.data.checks.transport.ok, false);
  assert.equal(fetchCalls, 0, 'readiness must NOT touch the network');
});

test('missing tenant context fails closed => 200 data.ready false tenant_context_required', async () => {
  const adapter = new TransportOTAAdapter({ channel: 'QYRVIA_CONNECT', transport: buildInProcessTransport() });
  const c = buildController({ channelManager: fakeCM({ QYRVIA_CONNECT: adapter }) });
  const res = fakeRes();
  await c.testConnection({ ctx: { requestId: 'rq2' }, body: { channel: 'QYRVIA_CONNECT' } }, res, () => {}); // no tenantId
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.data.ready, false);
  assert.equal(res._json.data.reason, 'tenant_context_required');
  assert.equal(res._json.data.checks.adapter, false, 'no probe runs without tenant context');
});

test('no secret leakage: credential-backed adapter never returns the secret value', async () => {
  let getCalls = 0;
  const SECRET = 'SUPER_SECRET_API_KEY_should_never_appear';
  const spyProvider = { async get() { getCalls += 1; return { api_key: SECRET }; } };
  const auth = new CredentialAuthStrategy({ credentialsRef: 'ref-1', tenantId: 't1', secretProvider: spyProvider });
  const adapter = new TransportOTAAdapter({ channel: 'EXPEDIA', transport: buildInProcessTransport(), auth });
  const c = buildController({ channelManager: fakeCM({ EXPEDIA: adapter }) });
  const res = fakeRes();
  await c.testConnection({ ctx: CTX, body: { channel: 'EXPEDIA' } }, res, () => {});
  assert.equal(res._json.data.ready, true);
  assert.equal(res._json.data.checks.credentials, true);
  assert.equal(getCalls, 0, 'presence check must NOT resolve the secret');
  assert.ok(!JSON.stringify(res._json).includes(SECRET), 'the secret value must never appear in the response');
});

test('route is registered with the test-connection path', () => {
  const adapter = new TransportOTAAdapter({ channel: 'QYRVIA_CONNECT', transport: buildInProcessTransport() });
  const router = build({ channelManager: fakeCM({ QYRVIA_CONNECT: adapter }) });
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes('/test-connection'), 'POST /test-connection must be mounted');
});
