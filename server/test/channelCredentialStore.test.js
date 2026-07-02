'use strict';

/** Phase 24 B8-B1 - secure OTA credential store, SecretProvider, AuthStrategy resolution. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { encrypt, decrypt } = require('../src/channel-manager/credentials/cryptoBox');
const { buildChannelCredentialStoreMemory } = require('../src/channel-manager/credentials/channelCredentialStore.memory');
const { buildChannelCredentialStoreDb } = require('../src/channel-manager/credentials/channelCredentialStore.db');
const { buildLocalEncryptedSecretProvider } = require('../src/channel-manager/credentials/secretProvider');
const { buildChannelCredentials } = require('../src/channel-manager/credentials');
const { CredentialAuthStrategy, NoopAuthStrategy } = require('../src/channel-manager/adapters/framework/AuthStrategy');
const { bridgeLegacyAdapter, validator } = require('../src/channel-manager/adapters/framework');
const { BookingComAdapter } = require('../src/channel-manager/adapters/bookingcom/BookingComAdapter');

const KEY = Buffer.alloc(32, 7); // deterministic 32-byte test key

function setup(onAudit) {
  const store = buildChannelCredentialStoreMemory({ clock: () => 1000 });
  const provider = buildLocalEncryptedSecretProvider({ store, key: KEY, clock: () => 2000, onAudit });
  return { store, provider };
}

// ---- crypto ----------------------------------------------------------------
test('cryptoBox: encrypt is not plaintext and decrypt round-trips; wrong key fails', () => {
  const box = encrypt(KEY, 'hello-secret');
  assert.notEqual(box.ciphertext, 'hello-secret');
  assert.ok(box.iv && box.tag && box.ciphertext);
  assert.equal(decrypt(KEY, box), 'hello-secret');
  assert.throws(() => decrypt(Buffer.alloc(32, 9), box));
});

// ---- CRUD ------------------------------------------------------------------
test('create + retrieve credential round-trips the payload', async () => {
  const { provider } = setup();
  const r = await provider.put('booking-com:prop1', { api_key: 'AK_123' }, { tenant_id: 't1', property_id: 'p1', channel: 'BOOKING_COM' });
  assert.equal(r.credentials_ref, 'booking-com:prop1');
  const got = await provider.get('booking-com:prop1', { tenant_id: 't1' });
  assert.deepEqual(got, { api_key: 'AK_123' });
});

// ---- rotation --------------------------------------------------------------
test('rotate: bumps key_version, sets rotated_at, new secret resolvable', async () => {
  const { store, provider } = setup();
  await provider.put('ref-r', { api_key: 'old' }, { tenant_id: 't1' });
  const v0 = store.get('t1', 'ref-r').key_version;
  const rot = await provider.rotate('ref-r', { tenant_id: 't1', newPayload: { api_key: 'new' } });
  assert.equal(rot.key_version, v0 + 1);
  const row = store.get('t1', 'ref-r');
  assert.equal(row.rotated_at, 2000);
  assert.deepEqual(await provider.get('ref-r', { tenant_id: 't1' }), { api_key: 'new' });
  // re-encrypt same payload (no newPayload) still bumps version
  const rot2 = await provider.rotate('ref-r', { tenant_id: 't1' });
  assert.equal(rot2.key_version, v0 + 2);
  assert.deepEqual(await provider.get('ref-r', { tenant_id: 't1' }), { api_key: 'new' });
});

// ---- revoke ----------------------------------------------------------------
test('revoke: get returns null, status REVOKED, ciphertext wiped', async () => {
  const { store, provider } = setup();
  await provider.put('ref-d', { api_key: 'x' }, { tenant_id: 't1' });
  await provider.revoke('ref-d', { tenant_id: 't1' });
  assert.equal(await provider.get('ref-d', { tenant_id: 't1' }), null);
  const row = store.get('t1', 'ref-d');
  assert.equal(row.status, 'REVOKED');
  assert.deepEqual(row.encrypted_payload, {});
});

// ---- RLS / tenant isolation ------------------------------------------------
test('RLS isolation: a tenant cannot read another tenant credential', async () => {
  const { provider } = setup();
  await provider.put('shared-ref', { token: 'A' }, { tenant_id: 'tA' });
  assert.equal(await provider.get('shared-ref', { tenant_id: 'tB' }), null);   // wrong tenant
  assert.deepEqual(await provider.get('shared-ref', { tenant_id: 'tA' }), { token: 'A' });
  await assert.rejects(() => provider.get('shared-ref', {}), /tenant_id required/); // tenant mandatory
});

// ---- no plaintext leakage (persistence + events + strategy) ----------------
test('no plaintext leakage in store, audit events, or AuthStrategy instance', async () => {
  const SECRET = 'sk_live_TOPSECRET_9f8e7d';
  const auditEvents = [];
  const { store, provider } = setup((e) => auditEvents.push(e));

  await provider.put('leak-ref', { api_key: SECRET }, { tenant_id: 't1', channel: 'BOOKING_COM' });
  await provider.rotate('leak-ref', { tenant_id: 't1' });

  // persistence: encrypted at rest
  const row = store.get('t1', 'leak-ref');
  assert.ok(!JSON.stringify(row).includes(SECRET), 'stored row must not contain plaintext');
  // events: audit carries metadata only
  assert.ok(auditEvents.length >= 2);
  assert.ok(!JSON.stringify(auditEvents).includes(SECRET), 'audit events must not contain plaintext');
  // strategy instance: holds only a ref + provider, never the secret
  const auth = new CredentialAuthStrategy({ credentialsRef: 'leak-ref', tenantId: 't1', secretProvider: provider });
  assert.ok(!JSON.stringify(auth).includes(SECRET), 'auth instance must not contain plaintext');
  // get() is the ONLY path to plaintext
  assert.equal((await provider.get('leak-ref', { tenant_id: 't1' })).api_key, SECRET);
});

// ---- AuthStrategy secret resolution ---------------------------------------
test('CredentialAuthStrategy resolves headers only via SecretProvider', async () => {
  const { provider } = setup();
  await provider.put('auth-ref', { api_key: 'AK_HDR' }, { tenant_id: 't1' });
  const auth = new CredentialAuthStrategy({ credentialsRef: 'auth-ref', tenantId: 't1', secretProvider: provider });
  assert.equal(auth.isValid(), true);
  assert.deepEqual(await auth.getAuthHeaders(), { 'X-Api-Key': 'AK_HDR' });
  // token form
  await provider.put('tok-ref', { token: 'TT' }, { tenant_id: 't1' });
  const auth2 = new CredentialAuthStrategy({ credentialsRef: 'tok-ref', tenantId: 't1', secretProvider: provider });
  assert.deepEqual(await auth2.getAuthHeaders(), { Authorization: 'Bearer TT' });
  // revoked => empty headers (no throw)
  await provider.revoke('auth-ref', { tenant_id: 't1' });
  assert.deepEqual(await auth.getAuthHeaders(), {});
});

// ---- adapter compatibility -------------------------------------------------
test('adapters consume credentials via auth without changing their contract', async () => {
  const { provider } = setup();
  await provider.put('bc-ref', { api_key: 'BC_KEY' }, { tenant_id: 't1', channel: 'BOOKING_COM' });
  const auth = new CredentialAuthStrategy({ credentialsRef: 'bc-ref', tenantId: 't1', secretProvider: provider });
  const bridged = bridgeLegacyAdapter(new BookingComAdapter(), { auth });
  // canonical contract still satisfied
  assert.equal(validator.validateInterface(bridged).ok, true);
  // adapter can resolve auth headers through the strategy
  assert.deepEqual(await bridged.auth.getAuthHeaders(), { 'X-Api-Key': 'BC_KEY' });
  // default bridged adapters still use NoopAuthStrategy (no secrets)
  assert.ok(bridgeLegacyAdapter(new BookingComAdapter()).auth instanceof NoopAuthStrategy);
});

// ---- factory + db store ----------------------------------------------------
test('factory: default memory, no provider without a key; provider with key', () => {
  const a = buildChannelCredentials({});
  assert.equal(a.mode, 'memory');
  assert.equal(a.hasProvider, false);
  const b = buildChannelCredentials({ key: KEY });
  assert.equal(b.hasProvider, true);
  assert.equal(typeof b.provider.put, 'function');
});

test('db credential store: put issues encrypted UPSERT SQL (no plaintext columns)', async () => {
  const calls = [];
  const db = { query: async (text, params) => { calls.push({ text, params }); return { rows: [{ id: 'x' }] }; } };
  const s = buildChannelCredentialStoreDb({ db });
  await s.put({ tenant_id: 't', credentials_ref: 'r', encrypted_payload: { iv: 'a', tag: 'b', ciphertext: 'c' } });
  assert.ok(calls.some((c) => /INSERT INTO channel_credential_store/.test(c.text)));
  assert.ok(calls.some((c) => /ON CONFLICT \(tenant_id, credentials_ref\)/.test(c.text)));
  assert.ok(calls.some((c) => /encrypted_payload/.test(c.text)));
});

// ---- migration validity ----------------------------------------------------
test('migration 0047: encrypted store with RLS + no plaintext columns', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/0047_channel_credential_store.sql'), 'utf8');
  assert.ok(sql.includes('CREATE TABLE channel_credential_store'));
  for (const col of ['tenant_id', 'property_id', 'channel', 'credentials_ref', 'credential_type', 'encrypted_payload', 'key_version', 'status', 'rotated_at', 'created_at', 'updated_at']) {
    assert.ok(sql.includes(col), 'missing column ' + col);
  }
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(sql) && /FORCE\s+ROW LEVEL SECURITY/.test(sql));
  assert.ok(/current_setting\('app\.tenant_id', true\)/.test(sql));
  assert.ok(/UNIQUE \(tenant_id, credentials_ref\)/.test(sql));
  // the ONLY credential-bearing column is encrypted_payload (no plaintext columns)
  const ddl = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n'); // strip full + inline comments (CRLF-safe: drop \r so --.*$ matches)
  assert.ok(/encrypted_payload\s+JSONB/.test(sql), 'encrypted_payload must be JSONB');
  assert.ok(!/\bplaintext\b|\bpassword\s+(VARCHAR|TEXT)|\bsecret_value\b/i.test(ddl), 'no plaintext credential column allowed');
});
