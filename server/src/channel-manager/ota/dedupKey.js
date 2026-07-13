'use strict';

const crypto = require('crypto');

const MAX_BYTES = 512;

const VOLATILE_KEYS = new Set([
  'received_at', 'timestamp', 'request_id', 'trace_id', 'signature',
  'authorization', 'access_token', 'password', 'card_number',
  'pan', 'cvv', 'cvc', 'security_code'
]);

function isVolatile(key) {
  return VOLATILE_KEYS.has(String(key).toLowerCase());
}

function _fail(msg) {
  // Bounded message — never includes payload content or secrets
  const err = new Error('buildDedupKey: ' + String(msg).slice(0, 200));
  err.code = 'OTA_DEDUP_KEY_REQUIRED';
  throw err;
}

// Recursively canonicalize a value: sort object keys, exclude volatile/sensitive
// fields, normalise non-plain types, detect circular references via WeakSet.
function _canonicalize(value, seen) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) _fail('circular reference detected in payload');
    seen.add(value);
    const result = value.map((v) => _canonicalize(v, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) _fail('circular reference detected in payload');
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (!isVolatile(key)) {
        const cv = _canonicalize(value[key], seen);
        // Drop undefined (mirrors JSON.stringify object behaviour)
        if (cv !== undefined) out[key] = cv;
      }
    }
    seen.delete(value);
    return out;
  }
  return value; // number (including NaN/Infinity — serialised to null by JSON.stringify), string, boolean
}

function _isUsable(p) {
  if (p === null || p === undefined) return false;
  if (typeof p === 'number' && (Number.isNaN(p) || !Number.isFinite(p))) return false;
  if (Buffer.isBuffer(p)) return p.length > 0;
  if (p instanceof Date) return !Number.isNaN(p.getTime());
  if (Array.isArray(p)) return p.length > 0;
  if (typeof p === 'object') return Object.keys(p).length > 0;
  return true; // string, finite number, boolean, BigInt
}

/**
 * Build a canonical, bounded dedup key for an OTA inbound event.
 *
 * The key is stored alongside (tenant_id, property_id, channel_code, event_type)
 * in the unique index, so it must only discriminate events within that scope.
 *
 * Priority:
 *   1. externalEventId — trimmed; returned directly if ≤ 512 UTF-8 bytes,
 *      otherwise SHA-256-hashed.  The original oversized value is never logged.
 *   2. payload fallback — canonical (key-sorted, volatile-stripped) JSON fingerprint.
 *
 * Throws { code: 'OTA_DEDUP_KEY_REQUIRED' } when no usable input exists.
 * Returned keys are always ≤ 512 UTF-8 bytes.
 */
function buildDedupKey({ externalEventId, payload } = {}) {
  // --- 1. External event ID ---
  if (externalEventId != null) {
    const trimmed = String(externalEventId).trim();
    if (trimmed.length > 0) {
      if (Buffer.byteLength(trimmed, 'utf8') <= MAX_BYTES) return trimmed;
      // Oversized: hash without exposing original content
      return 'sha256:' + crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex');
    }
  }

  // --- 2. Canonical payload fallback ---
  if (!_isUsable(payload)) {
    _fail('no usable externalEventId or payload');
  }

  let canonical;
  try {
    canonical = _canonicalize(payload, new WeakSet());
  } catch (e) {
    if (e && e.code === 'OTA_DEDUP_KEY_REQUIRED') throw e;
    _fail('payload canonicalization failed');
  }

  let json;
  try {
    json = JSON.stringify(canonical);
  } catch (e) {
    _fail('payload serialization failed');
  }

  if (!json || json === 'null' || json === '{}' || json === '[]') {
    _fail('payload reduced to empty after excluding volatile and sensitive keys');
  }

  return 'sha256:' + crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

module.exports = { buildDedupKey };
