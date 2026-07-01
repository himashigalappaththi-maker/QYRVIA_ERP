'use strict';

/**
 * cryptoBox (Phase 24 B8-B1) - AES-256-GCM authenticated encryption for credential
 * payloads. Produces { iv, tag, ciphertext } (base64) persisted in
 * channel_credential_store.encrypted_payload. The plaintext exists only
 * transiently inside encrypt()/decrypt(); it is never logged or returned except
 * by an explicit decrypt() call.
 */

const crypto = require('crypto');
const ALGO = 'aes-256-gcm';

function normalizeKey(key) {
  if (Buffer.isBuffer(key)) {
    if (key.length !== 32) throw new Error('cryptoBox: key buffer must be 32 bytes');
    return key;
  }
  if (typeof key === 'string' && key.length) {
    if (/^[0-9a-fA-F]{64}$/.test(key)) return Buffer.from(key, 'hex');
    const b = Buffer.from(key, 'base64');
    if (b.length === 32) return b;
    // Fallback: derive a 32-byte key from an arbitrary passphrase.
    return crypto.createHash('sha256').update(key).digest();
  }
  throw new Error('cryptoBox: key required (32-byte buffer, 64-hex, base64-32, or passphrase)');
}

function encrypt(key, plaintext) {
  const k = normalizeKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { algo: ALGO, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') };
}

function decrypt(key, box) {
  const k = normalizeKey(key);
  if (!box || !box.iv || !box.tag || !box.ciphertext) throw new Error('cryptoBox: invalid box');
  const decipher = crypto.createDecipheriv(ALGO, k, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt, normalizeKey, ALGO };
