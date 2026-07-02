'use strict';

/**
 * Phase 40 - channel credential (write-only) + mapping management API.
 * Credentials are stored ENCRYPTED and are NEVER returned; status/list are safe
 * metadata only; all handlers fail closed on missing tenant context.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildController } = require('../src/channel-manager/api/channel.controller');
const { build } = require('../src/channel-manager/api/channel.routes');
const { buildChannelCredentialStoreMemory } = require('../src/channel-manager/credentials/channelCredentialStore.memory');
const { buildLocalEncryptedSecretProvider } = require('../src/channel-manager/credentials/secretProvider');
const { buildChannelMappingService } = require('../src/channel-manager/mapping/channelMappingService');
const { buildChannelMappingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');
const { buildChannelMappingHistoryStoreMemory } = require('../src/channel-manager/mapping/channelMappingHistoryStore.memory');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };
const NOTENANT = { requestId: 'rq2' };

function fakeRes() {
  return { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
}
function credsDeps() {
  const store = buildChannelCredentialStoreMemory();
  const provider = buildLocalEncryptedSecretProvider({ store, key: 'unit-test-passphrase' });
  return { store, provider, mode: 'local', hasProvider: true };
}
function mappingDeps() {
  const mappingStore = buildChannelMappingStoreMemory();
  const historyStore = buildChannelMappingHistoryStoreMemory();
  const service = buildChannelMappingService({ mappingStore, historyStore });
  return { service, mappingStore, historyStore, mode: 'memory' };
}

// ---- credentials ----

test('P40: credentials save stores ENCRYPTED and never returns the secret; status is safe metadata', async () => {
  const credentials = credsDeps();
  const c = buildController({ channelManager: { getAdapter() { throw new Error('n/a'); } }, credentials });
  const SECRET = 'sk_live_SHOULD_NEVER_APPEAR_1234';

  const saveRes = fakeRes();
  await c.credentialsSave({ ctx: CTX, body: { channel: 'BOOKING_COM', credentials_ref: 'bc-ref', credential_type: 'API_KEY', payload: { api_key: SECRET } } }, saveRes, () => {});
  assert.equal(saveRes._json.ok, true);
  assert.equal(saveRes._json.result.configured, true);
  assert.ok(!JSON.stringify(saveRes._json).includes(SECRET), 'secret must never appear in the save response');

  // stored row holds only the encrypted box - never the plaintext
  const row = credentials.store.get('t1', 'bc-ref');
  assert.ok(row && row.encrypted_payload && row.encrypted_payload.ciphertext, 'payload is encrypted at rest');
  assert.ok(!JSON.stringify(row.encrypted_payload).includes(SECRET), 'ciphertext must not contain the plaintext');

  const statusRes = fakeRes();
  await c.credentialsStatus({ ctx: CTX, body: {} }, statusRes, () => {});
  assert.equal(statusRes._json.ok, true);
  assert.equal(statusRes._json.data.available, true);
  const item = statusRes._json.data.items.find((i) => i.credentials_ref === 'bc-ref');
  assert.ok(item && item.configured === true && item.channel === 'BOOKING_COM');
  assert.equal(item.encrypted_payload, undefined, 'status must not expose encrypted_payload');
  assert.ok(!JSON.stringify(statusRes._json).includes(SECRET), 'status must never leak the secret');
});

test('P40: credentials save validates body and fails closed on missing tenant / no provider', async () => {
  const credentials = credsDeps();
  const c = buildController({ channelManager: {}, credentials });
  const r1 = fakeRes(); await c.credentialsSave({ ctx: CTX, body: { channel: 'X' } }, r1, () => {}); // missing ref/payload
  assert.equal(r1._status, 400); assert.equal(r1._json.error, 'channel_credentials_required');
  const r2 = fakeRes(); await c.credentialsSave({ ctx: NOTENANT, body: { channel: 'X', credentials_ref: 'r', payload: {} } }, r2, () => {});
  assert.equal(r2._status, 401); assert.equal(r2._json.error, 'tenant_required');
  const cNoProv = buildController({ channelManager: {}, credentials: { store: credentials.store } }); // no provider
  const r3 = fakeRes(); await cNoProv.credentialsSave({ ctx: CTX, body: { channel: 'X', credentials_ref: 'r', payload: { k: 1 } } }, r3, () => {});
  assert.equal(r3._json.error, 'credentials_provider_unavailable');
});

test('P40: credentials status is graceful when no store is wired', async () => {
  const c = buildController({ channelManager: {} }); // no credentials
  const r = fakeRes(); await c.credentialsStatus({ ctx: CTX, body: {} }, r, () => {});
  assert.equal(r._json.ok, true); assert.equal(r._json.data.available, false); assert.deepEqual(r._json.data.items, []);
  const r2 = fakeRes(); await c.credentialsStatus({ ctx: NOTENANT, body: {} }, r2, () => {});
  assert.equal(r2._status, 401);
});

// ---- mappings ----

test('P40: mapping upsert then list returns safe metadata; tenant-scoped; fail-closed', async () => {
  const mapping = mappingDeps();
  const c = buildController({ channelManager: {}, mapping });

  const saveRes = fakeRes();
  await c.mappingsSave({ ctx: CTX, body: { channel: 'AGODA', room_type_id: 'rt-std', ota_room_id: 'AG-1001', ota_rate_plan_id: 'AG-RP-1' } }, saveRes, () => {});
  assert.equal(saveRes._json.ok, true);
  assert.equal(saveRes._json.result.mapping_version, 1);
  assert.equal(saveRes._json.result.change_type, 'CREATED');

  const listRes = fakeRes();
  await c.mappingsList({ ctx: CTX, body: {} }, listRes, () => {});
  assert.equal(listRes._json.data.available, true);
  const m = listRes._json.data.items.find((x) => x.room_type_id === 'rt-std');
  assert.ok(m && m.channel === 'AGODA' && m.ota_room_id === 'AG-1001' && m.enabled === true);
  // safe metadata only - no tenant_id / credentials_ref leaked in the projection
  assert.equal(m.tenant_id, undefined);
  assert.equal(m.credentials_ref, undefined);
});

test('P40: mapping save validates body and fails closed; list is graceful without a service', async () => {
  const mapping = mappingDeps();
  const c = buildController({ channelManager: {}, mapping });
  const r1 = fakeRes(); await c.mappingsSave({ ctx: CTX, body: { channel: 'A' } }, r1, () => {}); // no room_type_id
  assert.equal(r1._status, 400); assert.equal(r1._json.error, 'channel_room_type_required');
  const r2 = fakeRes(); await c.mappingsSave({ ctx: NOTENANT, body: { channel: 'A', room_type_id: 'r' } }, r2, () => {});
  assert.equal(r2._status, 401);
  const cNoSvc = buildController({ channelManager: {} }); // no mapping
  const r3 = fakeRes(); await cNoSvc.mappingsList({ ctx: CTX, body: {} }, r3, () => {});
  assert.equal(r3._json.data.available, false); assert.deepEqual(r3._json.data.items, []);
});

// ---- routes ----

test('P40: routes register credentials + mapping endpoints', () => {
  const router = build({ channelManager: { status() { return {}; } }, channelCredentials: credsDeps(), channelMapping: mappingDeps() });
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  for (const p of ['/credentials/status', '/credentials', '/mappings']) {
    assert.ok(paths.includes(p), 'route must be mounted: ' + p);
  }
});
