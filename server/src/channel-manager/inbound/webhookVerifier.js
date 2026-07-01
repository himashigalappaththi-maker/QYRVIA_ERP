'use strict';

/**
 * Webhook signature verifier (Phase 24 B8-B4) - HMAC-SHA256 over the raw body,
 * timing-safe comparison. The signing secret is resolved by the caller via the
 * SecretProvider (B8-B1); this module is pure (no secret storage, no I/O).
 */

const crypto = require('crypto');

function sign(secret, payload, algo = 'sha256') {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  return crypto.createHmac(algo, String(secret)).update(data).digest('hex');
}

function verify({ secret, payload, signature, algo = 'sha256' } = {}) {
  if (!secret || !signature) return false;
  const expected = sign(secret, payload, algo);
  if (String(signature).length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature))); }
  catch (_) { return false; }
}

module.exports = { sign, verify };
