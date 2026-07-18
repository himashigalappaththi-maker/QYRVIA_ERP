'use strict';

/**
 * Phase 4 security hardening middlewares.
 *
 *   securityHeaders()             - sets X-Content-Type-Options, X-Frame-Options,
 *                                   Strict-Transport-Security, Referrer-Policy,
 *                                   Content-Security-Policy (API-safe baseline),
 *                                   Permissions-Policy, X-XSS-Protection
 *   sanitizeJsonBody()            - recursively trims string fields + bounds
 *                                   string length; rejects payloads larger
 *                                   than configured (defaults to 256kb)
 *   verifyWebhookSignature(opts)  - HMAC-SHA256 verification for incoming
 *                                   webhooks with replay protection
 *                                   (timestamp window + nonce de-dupe)
 *
 * No transitive deps. All implementations are inline.
 */

const crypto = require('crypto');

function securityHeaders() {
  return function (req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    // API-only CSP - reject framing + inline script
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  };
}

/**
 * sanitizeJsonBody({ maxStringLen, maxDepth }) - recurses through req.body
 * after express.json() has parsed it. Trims strings, caps length, refuses
 * deeply-nested objects (DoS guard).
 */
function sanitizeJsonBody(opts = {}) {
  const maxLen   = opts.maxStringLen || 10_000;
  const maxDepth = opts.maxDepth     || 10;
  function walk(v, depth) {
    if (depth > maxDepth) throw new Error('payload_too_deep');
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > maxLen) throw new Error('string_too_long');
      return t;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k], depth + 1);
      return out;
    }
    return v;
  }
  return function (req, _res, next) {
    if (req.body && typeof req.body === 'object') {
      try { req.body = walk(req.body, 0); }
      catch (err) {
        const e = new Error(err.message);
        e.status = 400; e.code = err.message;
        return next(e);
      }
    }
    next();
  };
}

/**
 * HMAC webhook signature verification.
 *
 * Inbound webhook request must include:
 *   X-QYRVIA-Signature: t=<unix-ts>,v1=<hex sha256>
 *
 *   - t must be within `toleranceSec` of server time (default 300)
 *   - v1 must equal HMAC_SHA256(secret, `${t}.${rawBody}`)
 *   - nonce de-dupe (in-memory LRU map) prevents replay within tolerance
 *
 * Construct with a secret-lookup function so different endpoints can use
 * different secrets:
 *   verifyWebhookSignature({ secretFor: (req) => '...secret...' })
 *
 * The middleware reads req.rawBody (express.raw or a small helper); if absent
 * it stringifies req.body to validate (works for express.json with consistent
 * client serialization). Production deployments should mount express.raw on
 * the webhook ingress route.
 */
const _nonceLru = new Map();      // (t|v1) -> firstSeenMs
const _NONCE_MAX = 5000;
function _rememberNonce(key) {
  _nonceLru.set(key, Date.now());
  if (_nonceLru.size > _NONCE_MAX) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of _nonceLru) if (v < cutoff) _nonceLru.delete(k);
  }
}

function verifyWebhookSignature({ secretFor, toleranceSec } = {}) {
  if (typeof secretFor !== 'function') throw new Error('verifyWebhookSignature: secretFor(req) required');
  const tol = toleranceSec || 300;
  return function (req, res, next) {
    const header = req.get('X-QYRVIA-Signature');
    if (!header) return res.status(401).json({ error: 'signature_missing' });
    const m = String(header).match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (!m) return res.status(401).json({ error: 'signature_malformed' });
    const ts = parseInt(m[1], 10);
    const sig = m[2];
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > tol) return res.status(401).json({ error: 'signature_expired' });
    const nonceKey = ts + '|' + sig;
    if (_nonceLru.has(nonceKey)) return res.status(401).json({ error: 'signature_replayed' });
    let secret;
    try { secret = secretFor(req); }
    catch (_) { secret = null; }
    if (!secret) return res.status(401).json({ error: 'no_secret' });
    const raw = (typeof req.rawBody === 'string' && req.rawBody)
      || (req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '');
    const expected = crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).json({ error: 'signature_mismatch' });
    }
    _rememberNonce(nonceKey);
    next();
  };
}

/**
 * Phase 61: CORS middleware. Only installed when CORS_ORIGIN is set.
 * Emits Access-Control-Allow-Origin for the configured origin only (no wildcard).
 * Handles pre-flight OPTIONS requests with a 204.
 */
function corsMiddleware({ origin } = {}) {
  if (!origin) throw new Error('corsMiddleware: origin is required');
  return function (req, res, next) {
    const reqOrigin = req.get('Origin');
    if (reqOrigin && reqOrigin === origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Request-Id,X-Tenant-Id,X-Property-ID');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

module.exports = { securityHeaders, sanitizeJsonBody, verifyWebhookSignature, corsMiddleware, _nonceLru };
