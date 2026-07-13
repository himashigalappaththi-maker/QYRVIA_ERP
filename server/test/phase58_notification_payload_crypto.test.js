'use strict';

// Must be set before any require that transitively loads src/config/env.js.
// QYRVIA_NOTIFICATION_ENCRYPTION_KEY is intentionally NOT set globally here:
// the suite contains missing-key and malformed-key tests that verify behaviour
// when no key is configured; each test that needs a key passes it via options.key.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/qyrvia_test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'phase58-test-jwt-secret-at-least-32-characters';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');

const {
  encryptNotificationPayload,
  decryptNotificationPayload,
} = require('../src/security/notificationPayloadCrypto');

// ── Test key helpers ─────────────────────────────────────────────────────────

// 32-byte key A — primary test key
const KEY_A = Buffer.alloc(32, 0x11).toString('base64');
// 32-byte key B — used to test wrong-key failure
const KEY_B = Buffer.alloc(32, 0x22).toString('base64');

// Encrypt arbitrary UTF-8 content bypassing payload-type validation.
// Used to craft records with non-object, non-JSON, or synthetic plaintext.
function encryptRaw(content, keyBase64) {
  const keyBuf = Buffer.from(keyBase64, 'base64');
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv, { authTagLength: 16 });
  const enc    = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return {
    encrypted_payload:          enc.toString('base64'),
    encryption_iv:              iv.toString('base64'),
    encryption_tag:             tag.toString('base64'),
    encryption_payload_version: 1,
    encryption_key_version:     '1',
  };
}

// ── 1. Basic round-trip ──────────────────────────────────────────────────────

test('object round-trip succeeds', () => {
  const payload = { userId: 'u-1', type: 'password_reset' };
  const rec     = encryptNotificationPayload(payload, { key: KEY_A });
  const out     = decryptNotificationPayload(rec, { key: KEY_A });
  assert.deepEqual(out, payload);
});

// ── 2. Complex nested payload ────────────────────────────────────────────────

test('nested objects and arrays inside payload survive round-trip', () => {
  const payload = {
    user: { id: 'u-1', roles: ['admin', 'staff'] },
    meta: { ts: 1234567890, flags: { verified: true } },
    items: [1, 'two', null, false],
  };
  const rec = encryptNotificationPayload(payload, { key: KEY_A });
  const out = decryptNotificationPayload(rec, { key: KEY_A });
  assert.deepEqual(out, payload);
});

// ── 3. IV and ciphertext are fresh each call ─────────────────────────────────

test('two encryptions of the same object produce different IVs', () => {
  const payload = { x: 1 };
  const r1 = encryptNotificationPayload(payload, { key: KEY_A });
  const r2 = encryptNotificationPayload(payload, { key: KEY_A });
  assert.notEqual(r1.encryption_iv, r2.encryption_iv);
});

test('two encryptions of the same object produce different ciphertext', () => {
  const payload = { x: 1 };
  const r1 = encryptNotificationPayload(payload, { key: KEY_A });
  const r2 = encryptNotificationPayload(payload, { key: KEY_A });
  assert.notEqual(r1.encrypted_payload, r2.encrypted_payload);
});

// ── 4. Ciphertext does not contain sensitive plaintext ───────────────────────

test('ciphertext does not contain raw token, email or reset URL', () => {
  const rawToken = 'tok-super-secret-abc123';
  const email    = 'alice@example.com';
  const resetUrl = 'https://app.example.com/reset?token=tok-super-secret-abc123';

  const rec        = encryptNotificationPayload({ rawToken, email, resetUrl }, { key: KEY_A });
  const cipherText = Buffer.from(rec.encrypted_payload, 'base64').toString('binary');

  assert.ok(!cipherText.includes(rawToken), 'ciphertext must not contain raw token');
  assert.ok(!cipherText.includes(email),    'ciphertext must not contain email');
  assert.ok(!cipherText.includes('reset?'), 'ciphertext must not contain reset URL fragment');
});

// ── 5–7. Tamper detection ────────────────────────────────────────────────────

test('tampered ciphertext fails with CRYPTO_AUTH_FAILED', () => {
  const rec = encryptNotificationPayload({ msg: 'ok' }, { key: KEY_A });
  const buf = Buffer.from(rec.encrypted_payload, 'base64');
  buf[0] ^= 0xff;
  const tampered = { ...rec, encrypted_payload: buf.toString('base64') };
  assert.throws(
    () => decryptNotificationPayload(tampered, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_AUTH_FAILED',
  );
});

test('tampered authentication tag fails with CRYPTO_AUTH_FAILED', () => {
  const rec    = encryptNotificationPayload({ msg: 'ok' }, { key: KEY_A });
  const tagBuf = Buffer.from(rec.encryption_tag, 'base64');
  tagBuf[0] ^= 0xff;
  const tampered = { ...rec, encryption_tag: tagBuf.toString('base64') };
  assert.throws(
    () => decryptNotificationPayload(tampered, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_AUTH_FAILED',
  );
});

test('tampered IV fails with CRYPTO_AUTH_FAILED', () => {
  const rec = encryptNotificationPayload({ msg: 'ok' }, { key: KEY_A });
  // Use a different valid 12-byte IV so it passes format validation but GCM rejects it.
  let altIv;
  do { altIv = crypto.randomBytes(12).toString('base64'); } while (altIv === rec.encryption_iv);
  const tampered = { ...rec, encryption_iv: altIv };
  assert.throws(
    () => decryptNotificationPayload(tampered, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_AUTH_FAILED',
  );
});

// ── 8. Wrong key ─────────────────────────────────────────────────────────────

test('wrong key fails with CRYPTO_AUTH_FAILED', () => {
  const rec = encryptNotificationPayload({ secret: 'data' }, { key: KEY_A });
  assert.throws(
    () => decryptNotificationPayload(rec, { key: KEY_B }),
    (e) => e.code === 'CRYPTO_AUTH_FAILED',
  );
});

// ── 9. Missing key ───────────────────────────────────────────────────────────

test('missing key (empty string injection) fails with CRYPTO_KEY_MISSING', () => {
  assert.throws(
    () => encryptNotificationPayload({ a: 1 }, { key: '' }),
    (e) => e.code === 'CRYPTO_KEY_MISSING',
  );
});

test('missing key on decrypt (empty string injection) fails with CRYPTO_KEY_MISSING', () => {
  const rec = encryptNotificationPayload({ a: 1 }, { key: KEY_A });
  assert.throws(
    () => decryptNotificationPayload(rec, { key: '' }),
    (e) => e.code === 'CRYPTO_KEY_MISSING',
  );
});

// ── 10. Malformed / non-canonical Base64 key ─────────────────────────────────

test('malformed Base64 key (invalid chars) fails with CRYPTO_KEY_INVALID', () => {
  // Contains '!' which is not in the standard base64 alphabet
  const badKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!';
  assert.throws(
    () => encryptNotificationPayload({ a: 1 }, { key: badKey }),
    (e) => e.code === 'CRYPTO_KEY_INVALID',
  );
});

test('non-canonical Base64 key (URL-safe char) fails with CRYPTO_KEY_INVALID', () => {
  // Replace last char with URL-safe '-' (not in standard alphabet)
  const urlSafeKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-';
  assert.throws(
    () => encryptNotificationPayload({ a: 1 }, { key: urlSafeKey }),
    (e) => e.code === 'CRYPTO_KEY_INVALID',
  );
});

test('non-canonical Base64 key (missing padding) fails with CRYPTO_KEY_INVALID', () => {
  // A valid 32-byte key in base64 is 44 chars (43 content + 1 '=').
  // Removing the '=' makes length 43, not divisible by 4.
  const validKey   = Buffer.alloc(32, 0x42).toString('base64'); // ends with '='
  const noPadKey   = validKey.slice(0, -1);                     // strip padding
  assert.throws(
    () => encryptNotificationPayload({ a: 1 }, { key: noPadKey }),
    (e) => e.code === 'CRYPTO_KEY_INVALID',
  );
});

// ── 11. Key too short ────────────────────────────────────────────────────────

test('decoded key shorter than 32 bytes fails with CRYPTO_KEY_INVALID', () => {
  const shortKey = Buffer.alloc(16).toString('base64'); // 16 bytes → 24 chars
  assert.throws(
    () => encryptNotificationPayload({ a: 1 }, { key: shortKey }),
    (e) => e.code === 'CRYPTO_KEY_INVALID',
  );
});

// ── 12. Key too long ─────────────────────────────────────────────────────────

test('decoded key longer than 32 bytes fails with CRYPTO_KEY_INVALID', () => {
  const longKey = Buffer.alloc(48).toString('base64'); // 48 bytes → 64 chars
  assert.throws(
    () => encryptNotificationPayload({ a: 1 }, { key: longKey }),
    (e) => e.code === 'CRYPTO_KEY_INVALID',
  );
});

// ── 13. Missing encryption fields ────────────────────────────────────────────

const REQUIRED_FIELDS = [
  'encrypted_payload',
  'encryption_iv',
  'encryption_tag',
  'encryption_payload_version',
  'encryption_key_version',
];

for (const field of REQUIRED_FIELDS) {
  test(`missing field '${field}' fails`, () => {
    const rec        = encryptNotificationPayload({ x: 1 }, { key: KEY_A });
    const incomplete = { ...rec };
    delete incomplete[field];
    assert.throws(() => decryptNotificationPayload(incomplete, { key: KEY_A }));
  });
}

// ── 14. Unsupported payload version ──────────────────────────────────────────

test('unsupported payload version fails with CRYPTO_VERSION_UNSUPPORTED', () => {
  const rec     = encryptNotificationPayload({ x: 1 }, { key: KEY_A });
  const altered = { ...rec, encryption_payload_version: 99 };
  assert.throws(
    () => decryptNotificationPayload(altered, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_VERSION_UNSUPPORTED',
  );
});

// ── 15. Unsupported key version ───────────────────────────────────────────────

test('unsupported key version fails with CRYPTO_VERSION_UNSUPPORTED', () => {
  const rec     = encryptNotificationPayload({ x: 1 }, { key: KEY_A });
  const altered = { ...rec, encryption_key_version: '2' };
  assert.throws(
    () => decryptNotificationPayload(altered, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_VERSION_UNSUPPORTED',
  );
});

// ── 16. Invalid IV length ─────────────────────────────────────────────────────

test('IV of 8 decoded bytes fails with CRYPTO_IV_INVALID', () => {
  const rec     = encryptNotificationPayload({ x: 1 }, { key: KEY_A });
  // 8 bytes → 12-char base64 (no padding, since 8 % 3... wait)
  // 8 / 3 = 2 complete groups (6 bytes → 8 chars) + 2 remaining bytes (→ 4 chars with 1 '=')
  // Total: 12 chars
  const shortIv = Buffer.alloc(8).toString('base64');
  assert.throws(
    () => decryptNotificationPayload({ ...rec, encryption_iv: shortIv }, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_IV_INVALID',
  );
});

test('IV of 16 decoded bytes fails with CRYPTO_IV_INVALID', () => {
  const rec    = encryptNotificationPayload({ x: 1 }, { key: KEY_A });
  const longIv = Buffer.alloc(16).toString('base64'); // 24-char base64
  assert.throws(
    () => decryptNotificationPayload({ ...rec, encryption_iv: longIv }, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_IV_INVALID',
  );
});

// ── 17. Invalid tag length ────────────────────────────────────────────────────

test('tag of 8 decoded bytes fails with CRYPTO_TAG_INVALID', () => {
  const rec      = encryptNotificationPayload({ x: 1 }, { key: KEY_A });
  const shortTag = Buffer.alloc(8).toString('base64');
  assert.throws(
    () => decryptNotificationPayload({ ...rec, encryption_tag: shortTag }, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_TAG_INVALID',
  );
});

test('tag of 12 decoded bytes fails with CRYPTO_TAG_INVALID', () => {
  const rec     = encryptNotificationPayload({ x: 1 }, { key: KEY_A });
  const wrongTag = Buffer.alloc(12).toString('base64'); // 16-char base64
  assert.throws(
    () => decryptNotificationPayload({ ...rec, encryption_tag: wrongTag }, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_TAG_INVALID',
  );
});

// ── 18. Malformed JSON after decryption ───────────────────────────────────────

test('malformed decrypted JSON fails with CRYPTO_JSON_INVALID', () => {
  const rec = encryptRaw('{not valid json}', KEY_A);
  assert.throws(
    () => decryptNotificationPayload(rec, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_JSON_INVALID',
  );
});

// ── 19. Decrypted primitive or array payload is rejected ──────────────────────

test('decrypted array payload is rejected with CRYPTO_PAYLOAD_INVALID', () => {
  const rec = encryptRaw(JSON.stringify([1, 2, 3]), KEY_A);
  assert.throws(
    () => decryptNotificationPayload(rec, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_PAYLOAD_INVALID',
  );
});

test('decrypted null payload is rejected with CRYPTO_PAYLOAD_INVALID', () => {
  const rec = encryptRaw('null', KEY_A);
  assert.throws(
    () => decryptNotificationPayload(rec, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_PAYLOAD_INVALID',
  );
});

test('decrypted string payload is rejected with CRYPTO_PAYLOAD_INVALID', () => {
  const rec = encryptRaw('"just a string"', KEY_A);
  assert.throws(
    () => decryptNotificationPayload(rec, { key: KEY_A }),
    (e) => e.code === 'CRYPTO_PAYLOAD_INVALID',
  );
});

// ── 20. Return types match migration 0077 SQL column types exactly ────────────

test('returned field types and lengths match migration 0077 column definitions', () => {
  const rec = encryptNotificationPayload({ payload: true }, { key: KEY_A });

  // encrypted_payload  TEXT          → non-empty string
  assert.equal(typeof rec.encrypted_payload, 'string');
  assert.ok(rec.encrypted_payload.length > 0);

  // encryption_iv      VARCHAR(24)   → 12-byte IV base64 = 16 chars (12 % 3 === 0, no padding)
  assert.equal(typeof rec.encryption_iv, 'string');
  assert.equal(Buffer.from(rec.encryption_iv, 'base64').length, 12);
  assert.equal(rec.encryption_iv.length, 16);
  assert.ok(rec.encryption_iv.length <= 24, 'must fit VARCHAR(24)');

  // encryption_tag     VARCHAR(32)   → 16-byte tag base64 = 24 chars (16 % 3 === 1, '==' padding)
  assert.equal(typeof rec.encryption_tag, 'string');
  assert.equal(Buffer.from(rec.encryption_tag, 'base64').length, 16);
  assert.equal(rec.encryption_tag.length, 24);
  assert.ok(rec.encryption_tag.length <= 32, 'must fit VARCHAR(32)');

  // encryption_payload_version  SMALLINT → integer 1
  assert.equal(typeof rec.encryption_payload_version, 'number');
  assert.equal(rec.encryption_payload_version, 1);
  assert.ok(Number.isInteger(rec.encryption_payload_version));

  // encryption_key_version  VARCHAR(40) → string '1'
  assert.equal(typeof rec.encryption_key_version, 'string');
  assert.equal(rec.encryption_key_version, '1');
  assert.ok(rec.encryption_key_version.length <= 40, 'must fit VARCHAR(40)');
});
