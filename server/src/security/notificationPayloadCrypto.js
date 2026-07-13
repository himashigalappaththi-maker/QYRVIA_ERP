'use strict';

const crypto = require('node:crypto');
const config = require('../config/env');

const PAYLOAD_VERSION = 1;
const KEY_VERSION     = '1';
const ALGORITHM       = 'aes-256-gcm';
const IV_BYTES        = 12;
const TAG_BYTES       = 16;
const KEY_BYTES       = 32;

function _err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Standard Base64 only: A–Z a–z 0–9 + / with ≤2 trailing = and length divisible by 4.
// Rejects URL-safe chars (- _), whitespace, and non-canonical padding.
function _isValidBase64(s) {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(s)
  );
}

function _loadKey(options) {
  const raw = (options != null && options.key !== undefined)
    ? options.key
    : config.QYRVIA_NOTIFICATION_ENCRYPTION_KEY;

  if (!raw) throw _err('Notification encryption key is not configured', 'CRYPTO_KEY_MISSING');
  if (!_isValidBase64(raw)) throw _err('Encryption key is not valid Base64', 'CRYPTO_KEY_INVALID');

  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw _err('Encryption key must decode to exactly 32 bytes', 'CRYPTO_KEY_INVALID');
  }
  return buf;
}

/**
 * Encrypt a plain JS object using AES-256-GCM.
 *
 * Returns the five columns defined by migration 0077 (all text/varchar — no BYTEA).
 * The payload is serialised with JSON.stringify; caller must never pass a non-object.
 */
function encryptNotificationPayload(payload, options = {}) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw _err('payload must be a plain non-null JavaScript object', 'CRYPTO_PAYLOAD_INVALID');
  }

  const keyBuf  = _loadKey(options);
  const iv      = crypto.randomBytes(IV_BYTES);
  const cipher  = crypto.createCipheriv(ALGORITHM, keyBuf, iv, { authTagLength: TAG_BYTES });
  const enc     = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag     = cipher.getAuthTag();

  return {
    encrypted_payload:          enc.toString('base64'),
    encryption_iv:              iv.toString('base64'),
    encryption_tag:             tag.toString('base64'),
    encryption_payload_version: PAYLOAD_VERSION,
    encryption_key_version:     KEY_VERSION,
  };
}

/**
 * Decrypt and authenticate an encrypted notification record.
 *
 * Validates all five envelope fields before calling createDecipheriv.
 * Returns the original JS object; never returns unauthenticated or partial plaintext.
 */
function decryptNotificationPayload(record, options = {}) {
  if (record === null || typeof record !== 'object') {
    throw _err('record must be a non-null object', 'CRYPTO_RECORD_INVALID');
  }

  const {
    encrypted_payload,
    encryption_iv,
    encryption_tag,
    encryption_payload_version,
    encryption_key_version,
  } = record;

  // ── field presence / type checks ─────────────────────────────────────────────

  if (typeof encrypted_payload !== 'string' || encrypted_payload.length === 0) {
    throw _err('encrypted_payload is missing or empty', 'CRYPTO_FIELD_MISSING');
  }
  if (typeof encryption_iv !== 'string') {
    throw _err('encryption_iv is missing', 'CRYPTO_FIELD_MISSING');
  }
  if (typeof encryption_tag !== 'string') {
    throw _err('encryption_tag is missing', 'CRYPTO_FIELD_MISSING');
  }
  if (encryption_payload_version == null) {
    throw _err('encryption_payload_version is missing', 'CRYPTO_FIELD_MISSING');
  }
  if (encryption_key_version == null) {
    throw _err('encryption_key_version is missing', 'CRYPTO_FIELD_MISSING');
  }

  // ── version checks ───────────────────────────────────────────────────────────

  if (encryption_payload_version !== PAYLOAD_VERSION) {
    throw _err(`Unsupported payload version: ${encryption_payload_version}`, 'CRYPTO_VERSION_UNSUPPORTED');
  }
  if (encryption_key_version !== KEY_VERSION) {
    throw _err(`Unsupported key version: ${encryption_key_version}`, 'CRYPTO_VERSION_UNSUPPORTED');
  }

  // ── IV validation ─────────────────────────────────────────────────────────────

  if (!_isValidBase64(encryption_iv)) {
    throw _err('encryption_iv is not valid Base64', 'CRYPTO_IV_INVALID');
  }
  const ivBuf = Buffer.from(encryption_iv, 'base64');
  if (ivBuf.length !== IV_BYTES) {
    throw _err('encryption_iv must decode to exactly 12 bytes', 'CRYPTO_IV_INVALID');
  }

  // ── tag validation ────────────────────────────────────────────────────────────

  if (!_isValidBase64(encryption_tag)) {
    throw _err('encryption_tag is not valid Base64', 'CRYPTO_TAG_INVALID');
  }
  const tagBuf = Buffer.from(encryption_tag, 'base64');
  if (tagBuf.length !== TAG_BYTES) {
    throw _err('encryption_tag must decode to exactly 16 bytes', 'CRYPTO_TAG_INVALID');
  }

  // ── authenticated decryption ──────────────────────────────────────────────────

  const keyBuf    = _loadKey(options);
  const cipherBuf = Buffer.from(encrypted_payload, 'base64');
  const decipher  = crypto.createDecipheriv(ALGORITHM, keyBuf, ivBuf);
  decipher.setAuthTag(tagBuf);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(cipherBuf), decipher.final()]).toString('utf8');
  } catch {
    throw _err('Authenticated decryption failed', 'CRYPTO_AUTH_FAILED');
  }

  // ── parse and type-check ──────────────────────────────────────────────────────

  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw _err('Decrypted payload is not valid JSON', 'CRYPTO_JSON_INVALID');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw _err('Decrypted payload must be a non-null, non-array object', 'CRYPTO_PAYLOAD_INVALID');
  }

  return parsed;
}

module.exports = { encryptNotificationPayload, decryptNotificationPayload };
