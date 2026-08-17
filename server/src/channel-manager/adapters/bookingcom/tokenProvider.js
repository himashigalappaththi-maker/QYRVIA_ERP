'use strict';

/**
 * Phase 69A (instruction 048) — Booking.com token-based machine-account
 * authentication.
 *
 * Booking.com's Basic-auth scheme sunset 31 December 2025; new integration
 * work must use the documented token-exchange flow instead:
 *
 *   POST https://connectivity-authentication.booking.com/token-based-authentication/exchange
 *   Content-Type: application/json
 *   { "client_id": "...", "client_secret": "..." }
 *   -> { jwt, ruid? }, used as `Authorization: Bearer {jwt}`.
 *   Documented: ~1 hour token lifetime, 30 token generations/hour limit.
 *
 * This module is the ONLY place client_secret is ever handed to an HTTP
 * call, and the ONLY place a JWT is ever held (in-memory, per credential
 * identity, never persisted — never DB, never audit log, never application
 * log, never server/.env, never returned through any public API). It never
 * makes a network call unless the caller injects an ENABLED http transport
 * (default: a local disabled stub — zero network by construction, matching
 * every other transport default in this codebase).
 *
 * Cache + single-flight: bounded in-memory Map keyed by credentialsRef (an
 * opaque QYRVIA reference — never the secret itself). At most one exchange
 * is ever in flight per credentialsRef at a time; concurrent callers for the
 * same credentialsRef all resolve to the one in-flight exchange's result.
 * On failure the in-flight entry is cleared so the NEXT call may retry —
 * a permanently-stuck in-flight promise would otherwise wedge every future
 * caller for that credential forever.
 */

const TOKEN_EXCHANGE_ENDPOINT = 'https://connectivity-authentication.booking.com/token-based-authentication/exchange';

// Conservative fallback when the JWT's own `exp` claim cannot be safely read
// (malformed token, unexpected shape) — deliberately UNDER the documented
// ~1 hour lifetime, never over it, so a token is never used past a point
// Booking.com may have already expired it.
const DEFAULT_MAX_LIFETIME_MS = 55 * 60 * 1000; // 55 minutes
const DEFAULT_SKEW_MS = 60 * 1000;              // refresh 60s before computed expiry

function classifiedError(code, retryable, message) {
  const e = new Error(message || code);
  e.code = code;
  e.retryable = !!retryable;
  return e;
}

/** HTTP status -> {retryable, code} per instruction 048 Section 11. */
function classifyTokenExchangeStatus(status) {
  if (status === 400) return { retryable: false, code: 'BOOKING_COM_TOKEN_BAD_REQUEST' };
  if (status === 401) return { retryable: false, code: 'BOOKING_COM_TOKEN_INVALID_CREDENTIALS' };
  if (status === 429) return { retryable: true, code: 'BOOKING_COM_TOKEN_RATE_LIMITED' };
  if (status >= 500) return { retryable: true, code: 'BOOKING_COM_TOKEN_SERVER_ERROR' };
  return { retryable: false, code: 'BOOKING_COM_TOKEN_HTTP_' + status };
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Best-effort JWT claims decode (the payload segment only — this is NOT
 * signature verification; instruction 049 Section 16 explicitly says not to
 * implement cryptographic JWT verification absent an official key-validation
 * contract already in this repo. This is an environment SAFETY cross-check
 * read off an already-trusted response, never an authentication mechanism).
 * Returns the parsed claims object, or null if the token is malformed in
 * any way. NEVER throws.
 */
function safeParseJwtClaims(jwt) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length < 2) return null;
    const claims = JSON.parse(base64UrlDecode(parts[1]));
    return (claims && typeof claims === 'object') ? claims : null;
  } catch (_) {
    return null;
  }
}

/** Best-effort JWT `exp` (seconds since epoch) -> ms, or null if unreadable. Never throws. */
function safeParseJwtExpiryMs(jwt) {
  const claims = safeParseJwtClaims(jwt);
  if (!claims || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
  return claims.exp * 1000;
}

/**
 * Phase 69A (instruction 049 Section 16) — Booking.com's documented
 * token-based auth includes a JWT `test` claim describing the token's
 * environment. This is an ADDITIONAL safety cross-check for the future
 * TEST-property path (never the ONLY environment control — see
 * testPropertyGuard.js, which ANDs this with channel_registry.status,
 * credential environment, and mapping/credential binding).
 * Normalizes to exactly one of:
 *   true   -> the claim is present and unambiguously indicates TEST
 *   false  -> the claim is present and unambiguously indicates NOT-test
 *   null   -> the claim is absent, or its value is not unambiguous — the
 *             caller (the TEST guard) is REQUIRED to fail closed on null,
 *             per instruction 049 Section 16 ("If the JWT lacks the claim:
 *             fail closed... unless official contract evidence establishes
 *             another safe interpretation" — no such evidence exists in
 *             this repository, so null is never treated as "assume TEST").
 * Never throws.
 */
function normalizeTestClaim(claims) {
  if (!claims || !('test' in claims)) return null;
  const v = claims.test;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null; // present but ambiguous shape — fail closed, never guess
}

function buildDisabledHttpStub() {
  return { enabled: false, async send() { return { ok: false, status: 0, body: null, error: 'transport_disabled' }; } };
}

/**
 * @param {object}   [deps.http]        injected transport with async send(req) ->
 *        {ok,status,body,error?} — same shape as channel-manager/transport/transport.js's
 *        buildHttpTransport(). Default: disabled stub (NO network by default).
 * @param {Function} [deps.clock]       () => ms epoch, injectable for tests.
 * @param {string}   [deps.tokenEndpoint] override for tests/fixtures only.
 * @param {number}   [deps.skewMs]
 * @param {number}   [deps.maxLifetimeMs]
 * @param {object}   [deps.logger]      SAFE metadata only (credentialsRef + timestamps) — NEVER secret/jwt.
 */
function buildBookingComTokenProvider({
  http, clock = () => Date.now(), tokenEndpoint = TOKEN_EXCHANGE_ENDPOINT,
  skewMs = DEFAULT_SKEW_MS, maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS, logger
} = {}) {
  const send = http || buildDisabledHttpStub();
  const log = logger || { info() {}, warn() {} };

  // credentialsRef -> { token, expiresAt, ruid }. Never a second independent
  // secret store — client_secret itself is never cached here, only the
  // short-lived JWT this module exchanged it for.
  const cache = new Map();
  // credentialsRef -> Promise<{token,expiresAt,ruid}> — single-flight ledger.
  const inFlight = new Map();

  async function exchange({ clientId, clientSecret }) {
    let raw;
    try {
      raw = await send.send({
        method: 'POST',
        endpoint: tokenEndpoint,
        headers: { 'Content-Type': 'application/json' },
        payload: { client_id: clientId, client_secret: clientSecret }
      });
    } catch (e) {
      throw classifiedError('BOOKING_COM_TOKEN_NETWORK_ERROR', true, String((e && e.message) || e));
    }
    if (raw && raw.error === 'timeout') throw classifiedError('BOOKING_COM_TOKEN_TIMEOUT', true);
    // Disabled-by-default transport is a LOCAL configuration state, not a
    // provider-side rejection — retryable once an operator enables it.
    if (raw && raw.error === 'transport_disabled') throw classifiedError('BOOKING_COM_TOKEN_TRANSPORT_DISABLED', true);
    if (!raw || !raw.ok) {
      const status = (raw && raw.status) || 0;
      const cls = classifyTokenExchangeStatus(status);
      throw classifiedError(cls.code, cls.retryable, 'Booking.com token exchange failed: HTTP ' + status);
    }
    const jwt = raw.body && typeof raw.body.jwt === 'string' ? raw.body.jwt : null;
    if (!jwt) throw classifiedError('BOOKING_COM_TOKEN_MISSING_JWT_IN_RESPONSE', false);
    const ruid = raw.body && typeof raw.body.ruid === 'string' ? raw.body.ruid : null;
    const parsedExpiryMs = safeParseJwtExpiryMs(jwt);
    const expiresAt = parsedExpiryMs != null ? parsedExpiryMs : (clock() + maxLifetimeMs);
    const testClaim = normalizeTestClaim(safeParseJwtClaims(jwt));
    return { token: jwt, expiresAt, ruid, testClaim };
  }

  /**
   * @returns {Promise<{token:string, expiresAt:number, ruid:string|null, testClaim:boolean|null, cached:boolean}>}
   */
  async function getToken({ credentialsRef, clientId, clientSecret } = {}) {
    if (!credentialsRef) throw classifiedError('BOOKING_COM_TOKEN_CREDENTIALS_REF_REQUIRED', false);
    if (!clientId || !clientSecret) throw classifiedError('BOOKING_COM_TOKEN_MISSING_CLIENT_CREDENTIALS', false);

    const now = clock();
    const cached = cache.get(credentialsRef);
    if (cached && (cached.expiresAt - skewMs) > now) {
      return { token: cached.token, expiresAt: cached.expiresAt, ruid: cached.ruid, testClaim: cached.testClaim, cached: true };
    }

    // Single-flight: everything up to here and the Map read/write below is
    // synchronous (no `await` yet in this call), so concurrent callers
    // issued in the same tick observe each other's inFlight entry correctly
    // — the second caller reuses the first's promise instead of starting a
    // second exchange.
    const existing = inFlight.get(credentialsRef);
    if (existing) return existing;

    const p = exchange({ clientId, clientSecret })
      .then((result) => {
        cache.set(credentialsRef, result);
        inFlight.delete(credentialsRef);
        log.info({ credentialsRef, expiresAt: result.expiresAt, testClaim: result.testClaim }, '[bookingcom-token] token acquired');
        return { token: result.token, expiresAt: result.expiresAt, ruid: result.ruid, testClaim: result.testClaim, cached: false };
      })
      .catch((err) => {
        // Clear in-flight state on failure so a later call can retry —
        // never leave a rejected promise permanently cached as "the" attempt.
        inFlight.delete(credentialsRef);
        log.warn({ credentialsRef, code: err && err.code, retryable: err && err.retryable }, '[bookingcom-token] token exchange failed');
        throw err;
      });
    inFlight.set(credentialsRef, p);
    return p;
  }

  /** Discard any cached token for this credential identity (e.g. on rotation). Never touches an in-flight exchange. */
  function invalidate(credentialsRef) {
    cache.delete(credentialsRef);
  }

  /**
   * Convenience: resolved secret -> Authorization header. Returns {} (no
   * header, never a thrown error) when the secret is not token-shaped —
   * callers that need a hard failure should call getToken() directly, which
   * throws a classified error instead.
   */
  async function toAuthHeaders({ credentialsRef, secret }) {
    if (!secret || !secret.client_id || !secret.client_secret) return {};
    const { token } = await getToken({ credentialsRef, clientId: secret.client_id, clientSecret: secret.client_secret });
    return { Authorization: 'Bearer ' + token };
  }

  return { getToken, invalidate, toAuthHeaders };
}

module.exports = {
  buildBookingComTokenProvider,
  classifyTokenExchangeStatus,
  safeParseJwtExpiryMs,
  safeParseJwtClaims,
  normalizeTestClaim,
  TOKEN_EXCHANGE_ENDPOINT,
  DEFAULT_MAX_LIFETIME_MS,
  DEFAULT_SKEW_MS
};
