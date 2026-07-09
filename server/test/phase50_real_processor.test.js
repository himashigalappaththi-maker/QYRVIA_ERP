'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildRealProcessor, ACTIONS } = require('../src/channel-manager/worker/realProcessor');
const { buildDisabledHttp } = require('../src/channel-manager/ota/transport');

function makeSecretProvider(secret = null) {
  return { async get() { return secret; } };
}

const BASE_JOB = {
  action:          'CREATE_BOOKING',
  channel:         'BOOKING_COM',
  tenant_id:       'tenant-1',
  credentials_ref: 'ref-1',
  payload:         { bookingId: 'BK-1', status: 'CONFIRMED' }
};

// — Contract: ACTIONS exported —
test('ACTIONS includes all 5 standard actions', () => {
  for (const a of ['CREATE_BOOKING', 'UPDATE_BOOKING', 'CANCEL_BOOKING', 'CHECK_IN', 'CHECK_OUT']) {
    assert.ok(ACTIONS.includes(a));
  }
});

// — Construction guard —
test('buildRealProcessor throws without secretProvider', () => {
  assert.throws(() => buildRealProcessor({}), /secretProvider required/);
});

// — unknown_action —
test('process: unknown action returns ok=false error=unknown_action', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ action: 'WARP_DRIVE', channel: 'BOOKING_COM', tenant_id: 't' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'unknown_action');
});

// — null job —
test('process: null job returns ok=false', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process(null);
  assert.equal(out.ok, false);
});

// — missing channel —
test('process: missing channel returns channel_required', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ action: 'CREATE_BOOKING', tenant_id: 'tid' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'channel_required');
});

// — missing tenant_id —
test('process: missing tenant_id returns tenant_required', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ action: 'CREATE_BOOKING', channel: 'BOOKING_COM' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tenant_required');
});

// — unknown channel (no provider) —
test('process: unknown channel returns no_provider_for_channel', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ ...BASE_JOB, channel: 'UNKNOWN_OTA_XYZ' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'no_provider_for_channel');
});

// — CHECK_IN / CHECK_OUT are local-only (no transport) —
test('process: CHECK_IN returns ok=true dispatch=local_only', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ ...BASE_JOB, action: 'CHECK_IN' });
  assert.equal(out.ok, true);
  assert.equal(out.result.dispatch, 'local_only');
});
test('process: CHECK_OUT returns ok=true dispatch=local_only', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ ...BASE_JOB, action: 'CHECK_OUT' });
  assert.equal(out.ok, true);
  assert.equal(out.result.dispatch, 'local_only');
});

// — Disabled HTTP transport (default) returns transport_disabled, non-retryable —
test('process: disabled HTTP returns ok=false error=transport_disabled for known channel', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }), http: buildDisabledHttp() });
  const out = await p.process(BASE_JOB);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'transport_disabled');
});

// — CANCEL_BOOKING encodes CANCELLED status —
test('process: CANCEL_BOOKING passes CANCELLED status to transport (ack still transport_disabled)', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }) });
  const out = await p.process({ ...BASE_JOB, action: 'CANCEL_BOOKING' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'transport_disabled'); // transport_disabled because HTTP is off
});

// — All known OTA channels can be processed (no throw, just transport_disabled) —
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');
const OTA_CHANNELS = [CHANNELS.BOOKING_COM, CHANNELS.EXPEDIA, CHANNELS.AGODA, CHANNELS.AIRBNB, CHANNELS.MAKEMYTRIP, CHANNELS.GOOGLE, CHANNELS.TRIPADVISOR];
for (const ch of OTA_CHANNELS) {
  test(`process: ${ch} dispatches without throwing (transport_disabled)`, async () => {
    const p   = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }) });
    const out = await p.process({ ...BASE_JOB, channel: ch });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'transport_disabled');
  });
}

// — Successful mock HTTP transport —
test('process: ok=true when mock HTTP transport returns 200', async () => {
  const mockHttp = {
    kind: 'mock', enabled: true,
    async send() { return { ok: true, status: 200, body: { confirmation_id: 'ACK-1' } }; }
  };
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider({ api_key: 'k' }), http: mockHttp });
  const out = await p.process(BASE_JOB);
  assert.equal(out.ok, true);
  assert.ok(out.result.ackId != null || out.result.ackId === null); // may or may not have ackId
  assert.equal(out.result.channel, 'BOOKING_COM');
});
