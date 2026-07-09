'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Minimal stubs
function makeSecretProvider() {
  const store = {};
  return {
    async put(ref, payload, { tenant_id }) { store[tenant_id + ':' + ref] = payload; return { credentials_ref: ref }; },
    async get(ref, { tenant_id }) { return store[tenant_id + ':' + ref] || null; }
  };
}

function makeChannelRegistry(initialStatus = 'not_configured') {
  let status = initialStatus;
  const calls = [];
  return {
    async get(channel, ctx) { return { channel_code: channel, status, tenant_id: ctx.tenantId }; },
    async setStatus(channel, s, ctx) { calls.push({ channel, status: s, tenantId: ctx.tenantId }); status = s; return { channel_code: channel, status }; },
    calls
  };
}

function makeCredentials(provider) { return { provider }; }

// Minimal Express-like request/response helpers
function makeReq(body, tenantId = 'tenant-1') {
  return { body, ctx: { tenantId, requestId: 'req-1' } };
}
function makeRes() {
  const r = { _status: 200, _body: null };
  r.status = (s) => { r._status = s; return r; };
  r.json   = (b) => { r._body = b; return r; };
  return r;
}

const { buildController } = require('../src/channel-manager/api/channel.controller');

// Minimal stub — only getAdapter() is needed by buildChannelConnectionTester at construction.
const stubCM = { getAdapter() { throw new Error('not_registered'); } };

test('credentialsSave: advances not_configured → configured when registry is wired', async () => {
  const provider    = makeSecretProvider();
  const registry    = makeChannelRegistry('not_configured');
  const credentials = makeCredentials(provider);

  const c   = buildController({ channelManager: stubCM, credentials, channelRegistry: registry });
  const req = makeReq({ channel: 'BOOKING_COM', credentials_ref: 'ref-1', payload: { api_key: 'key' } });
  const res = makeRes();

  await c.credentialsSave(req, res, (e) => { throw e; });

  assert.equal(res._body.ok, true);
  assert.equal(res._body.result.configured, true);
  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0].status, 'configured');
  assert.equal(registry.calls[0].channel, 'BOOKING_COM');
});

test('credentialsSave: does NOT downgrade live status', async () => {
  const provider    = makeSecretProvider();
  const registry    = makeChannelRegistry('live');    // already live
  const credentials = makeCredentials(provider);

  const c   = buildController({ channelManager: stubCM, credentials, channelRegistry: registry });
  const req = makeReq({ channel: 'BOOKING_COM', credentials_ref: 'ref-1', payload: { api_key: 'key2' } });
  const res = makeRes();

  await c.credentialsSave(req, res, (e) => { throw e; });

  assert.equal(res._body.ok, true);
  // Registry setStatus should NOT have been called (live is preserved).
  assert.equal(registry.calls.length, 0);
});

test('credentialsSave: does NOT downgrade sandbox or paused status', async () => {
  for (const existing of ['sandbox', 'paused', 'configured']) {
    const provider    = makeSecretProvider();
    const registry    = makeChannelRegistry(existing);
    const credentials = makeCredentials(provider);
    const c   = buildController({ channelManager: stubCM, credentials, channelRegistry: registry });
    const req = makeReq({ channel: 'AGODA', credentials_ref: 'ref-2', payload: { api_key: 'k' } });
    const res = makeRes();
    await c.credentialsSave(req, res, (e) => { throw e; });
    assert.equal(registry.calls.length, 0, `should not call setStatus when existing=${existing}`);
  }
});

test('credentialsSave: registry bridge failure does not block credential save', async () => {
  const provider    = makeSecretProvider();
  const badRegistry = {
    async get() { throw new Error('registry down'); },
    async setStatus() { throw new Error('registry down'); }
  };
  const credentials = makeCredentials(provider);
  const c   = buildController({ channelManager: stubCM, credentials, channelRegistry: badRegistry });
  const req = makeReq({ channel: 'EXPEDIA', credentials_ref: 'ref-3', payload: { token: 'tok' } });
  const res = makeRes();

  // Should not throw; credential save still succeeds.
  await c.credentialsSave(req, res, (e) => { throw e; });
  assert.equal(res._body.ok, true);
});

test('credentialsSave: works without channelRegistry (no bridge attempted)', async () => {
  const provider    = makeSecretProvider();
  const credentials = makeCredentials(provider);
  const c   = buildController({ channelManager: stubCM, credentials, channelRegistry: null });
  const req = makeReq({ channel: 'AIRBNB', credentials_ref: 'ref-4', payload: { access_token: 't' } });
  const res = makeRes();

  await c.credentialsSave(req, res, (e) => { throw e; });
  assert.equal(res._body.ok, true);
});
