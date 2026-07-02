'use strict';

/** Phase 24 B8-B5 - third-party OTA real HTTP transport (activated, fake fetch), auth, inbound secret. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelOutboundSync } = require('../src/channel-manager/sync');

function fakeFetch() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  fn.calls = calls;
  return fn;
}
// Fake SecretProvider: resolves an api_key (for outbound auth) + webhook_secret (for inbound).
const fakeProvider = { async get(ref, { tenant_id }) { return { api_key: 'AK_' + ref, webhook_secret: 'whsec_' + ref }; } };

const ACTIVATIONS = {
  BOOKING_COM: { enabled: true, http: true, endpoint: 'https://api.booking.test/v1', credentials_ref: 'bc:p1', tenant_id: 't1' }
};
const rate = { amount: 120, currency: 'USD', date: '2026-07-01' };

// ---- activated channel uses REAL HttpTransport (fake fetch) + auth headers -
test('activated Booking.com pushRate goes over HttpTransport with resolved auth headers', async () => {
  const fetchImpl = fakeFetch();
  const sync = buildChannelOutboundSync({ mode: 'memory', httpEnabled: true, fetchImpl, activations: ACTIVATIONS, secretProvider: fakeProvider });
  assert.ok(sync.httpChannels.includes('BOOKING_COM'));
  assert.equal(sync.service.isReal('BOOKING_COM'), true);

  const r = await sync.service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate });
  assert.equal(r.ok, true);
  assert.equal(r.real, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.booking.test/v1');
  assert.equal(fetchImpl.calls[0].opts.headers['X-Api-Key'], 'AK_bc:p1'); // auth resolved via SecretProvider
  const st = sync.syncStateStore.get('t1', 'BOOKING_COM', r.resource_key);
  assert.equal(st.last_status, 'OK');
});

// ---- HTTP master switch OFF => no network, FAILED status -------------------
test('activated channel with CHANNEL_HTTP_ENABLED off does NOT hit the network', async () => {
  const fetchImpl = fakeFetch();
  const sync = buildChannelOutboundSync({ mode: 'memory', httpEnabled: false, fetchImpl, activations: ACTIVATIONS, secretProvider: fakeProvider });
  const r = await sync.service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate });
  assert.equal(fetchImpl.calls.length, 0, 'transport disabled => no fetch');
  assert.equal(r.ok, false);
  const st = sync.syncStateStore.get('t1', 'BOOKING_COM', r.resource_key);
  assert.equal(st.last_status, 'FAILED');
});

// ---- default (no activations) => third-party is mock, no network ----------
test('default: no activations => Booking.com is a mock, QTCN only real channel', async () => {
  const fetchImpl = fakeFetch();
  const sync = buildChannelOutboundSync({ mode: 'memory', fetchImpl });
  assert.deepEqual(sync.httpChannels, []);
  assert.equal(sync.service.isReal('QTCN'), true);
  assert.equal(sync.service.isReal('BOOKING_COM'), false);
  await sync.service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate });
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- full bi-directional: outbound reservation push -----------------------
test('pushReservation delivers for an activated channel and records state', async () => {
  const fetchImpl = fakeFetch();
  const sync = buildChannelOutboundSync({ mode: 'memory', httpEnabled: true, fetchImpl, activations: ACTIVATIONS, secretProvider: fakeProvider });
  const r = await sync.service.pushReservation({ tenant_id: 't1', channel: 'BOOKING_COM', reservation: { bookingId: 'B1', status: 'CONFIRMED' } });
  assert.equal(r.ok, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(r.resource_key.includes('RESERVATION'));
});

// ---- inbound: per-channel signing secret resolution -----------------------
test('resolveSecret returns the channel webhook secret via the SecretProvider', async () => {
  const sync = buildChannelOutboundSync({ mode: 'memory', activations: ACTIVATIONS, secretProvider: fakeProvider });
  const secret = await sync.resolveSecret({ tenantId: 't1', channel: 'BOOKING_COM' });
  assert.equal(secret, 'whsec_bc:p1');
  // unknown / unconfigured channel => null
  assert.equal(await sync.resolveSecret({ tenantId: 't1', channel: 'AGODA' }), null);
  assert.equal(await sync.resolveSecret({ tenantId: 't1', channel: 'BOOKING_COM' }) && true, true);
});

// ---- no secret provider => no auth headers, no resolveSecret --------------
test('without a SecretProvider, activated channel sends no auth headers and resolveSecret is null', async () => {
  const fetchImpl = fakeFetch();
  const sync = buildChannelOutboundSync({ mode: 'memory', httpEnabled: true, fetchImpl, activations: ACTIVATIONS /* no provider */ });
  await sync.service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate });
  assert.deepEqual(fetchImpl.calls[0].opts.headers, {});            // no auth headers
  assert.equal(await sync.resolveSecret({ tenantId: 't1', channel: 'BOOKING_COM' }), null);
});

// ---- QTCN remains in-process (no network) even alongside HTTP channels -----
test('QTCN stays in-process (no fetch) when third-party HTTP is active', async () => {
  const fetchImpl = fakeFetch();
  const sync = buildChannelOutboundSync({ mode: 'memory', httpEnabled: true, fetchImpl, activations: ACTIVATIONS, secretProvider: fakeProvider });
  await sync.service.pushRate({ tenant_id: 't1', channel: 'QTCN', room_type_id: 'rt1', rate });
  assert.equal(sync.transports.inproc.deliveries.length, 1);       // delivered in-process
  assert.equal(fetchImpl.calls.length, 0);                          // QTCN never uses HTTP
});
