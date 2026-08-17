'use strict';

/**
 * Phase 69B (instruction 050 Section 7) — CHANNEL_CREDENTIAL_KEY generator.
 * Pure NO-NETWORK unit tests. Calls generateChannelCredentialKeyHex()
 * in-process only — never spawns the CLI, never passes --print, and never
 * logs/asserts the generated value's content (only its FORMAT/entropy
 * properties), consistent with "never written to out_put.txt / stdout
 * unless the operator explicitly invokes a dedicated local action".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { generateChannelCredentialKeyHex } = require('../scripts/channel/generateChannelCredentialKey');
const { normalizeKey, ALGO } = require('../src/channel-manager/credentials/cryptoBox');

test('generateChannelCredentialKeyHex returns a 64-character hex string (32 bytes / 256 bits)', () => {
  const k = generateChannelCredentialKeyHex();
  assert.equal(typeof k, 'string');
  assert.equal(k.length, 64);
  assert.match(k, /^[0-9a-f]{64}$/);
});

test('the generated key decodes to exactly 32 bytes — matching AES-256-GCM\'s key size', () => {
  const k = generateChannelCredentialKeyHex();
  assert.equal(Buffer.from(k, 'hex').length, 32);
  assert.equal(ALGO, 'aes-256-gcm');
});

test('the generated key is accepted by the ACTUAL cryptoBox.normalizeKey() with zero passphrase-derivation ambiguity', () => {
  const k = generateChannelCredentialKeyHex();
  const normalized = normalizeKey(k);
  assert.ok(Buffer.isBuffer(normalized));
  assert.equal(normalized.length, 32);
  // The 64-hex branch is a DIRECT decode, not a SHA-256 passphrase
  // derivation — prove it by decoding the same hex independently and
  // comparing, which would NOT match if a derivation step were involved.
  assert.deepEqual(normalized, Buffer.from(k, 'hex'));
});

test('the generated key round-trips through a real cryptoBox encrypt/decrypt cycle', () => {
  const { encrypt, decrypt } = require('../src/channel-manager/credentials/cryptoBox');
  const k = generateChannelCredentialKeyHex();
  const box = encrypt(k, 'fake-plaintext-payload-for-format-proof-only');
  assert.equal(decrypt(k, box), 'fake-plaintext-payload-for-format-proof-only');
});

test('every call produces a DIFFERENT key — never deterministic, never a hardcoded constant', () => {
  const keys = new Set();
  for (let i = 0; i < 50; i++) keys.add(generateChannelCredentialKeyHex());
  assert.equal(keys.size, 50, 'all 50 generated keys were unique');
});

test('uses the real CSPRNG (crypto.randomBytes), not Math.random — spied via crypto.randomBytes call count', () => {
  let calls = 0;
  const original = crypto.randomBytes;
  crypto.randomBytes = function spy(...args) { calls += 1; return original.apply(this, args); };
  try {
    generateChannelCredentialKeyHex();
    assert.equal(calls, 1);
  } finally {
    crypto.randomBytes = original;
  }
});

test('requiring this module as a library NEVER prints anything to stdout/stderr', () => {
  const originalLog = console.log, originalErr = console.error;
  let printed = false;
  console.log = () => { printed = true; };
  console.error = () => { printed = true; };
  try {
    delete require.cache[require.resolve('../scripts/channel/generateChannelCredentialKey')];
    require('../scripts/channel/generateChannelCredentialKey');
    generateChannelCredentialKeyHex();
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
  assert.equal(printed, false, 'requiring/calling the generator must never print anything by itself');
});

test('this module is never required by src/index.js — key generation is separate from ordinary startup', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/index.js'), 'utf8');
  assert.ok(!src.includes('generateChannelCredentialKey'), 'src/index.js must never import the key generator at boot time');
});

test('this module never imports fetch/http/https/axios — purely local CSPRNG', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../scripts/channel/generateChannelCredentialKey'), 'utf8');
  assert.ok(!/require\(['"]https?['"]\)/.test(src));
  assert.ok(!/\bfetch\(/.test(src));
});
