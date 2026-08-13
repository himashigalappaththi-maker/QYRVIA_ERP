'use strict';

const tokens = require('../services/tokens');
const logger = require('../config/logger');

/**
 * Authentication middleware. Extracts + verifies the JWT (signature, expiry,
 * issuer — see services/tokens.js's verifyAccessToken; audience is not used
 * by this codebase's token scheme). On success, attaches `req.user` with the
 * claims:
 *
 *   req.user = {
 *     sub:                  userId,
 *     tenant_id:            tenantId,
 *     primary_property_id:  propertyId | null,
 *     role_codes:           ['corporate_admin', ...],
 *     role_ids:             [uuid, ...],
 *     jti, iat, exp
 *   }
 *
 * On failure, responds 401 with a stable error code so the frontend can
 * choose to retry login or trigger refresh.
 *
 * Phase 67A Workstream B/C (instruction 003) — ACTIVE-only, fail-closed
 * current-status enforcement
 * ─────────────────────────────────────────────────────────────────────────
 * A cryptographically valid JWT only proves the token was issued and has
 * not expired; it says nothing about whether the account is still usable
 * right now. This middleware re-checks the CURRENT database record for
 * every protected request using a POSITIVE allow rule:
 *
 *     if (row.status !== 'ACTIVE') reject
 *
 * — not a blacklist of specific bad statuses. This means DISABLED,
 * TERMINATED, LOCKED, PENDING_PASSWORD_RESET, any future/unknown status
 * value, a missing user, and a soft-deleted user are ALL rejected, without
 * this file needing to know every status value that might ever exist. The
 * database record is authoritative; the JWT's own claims never carry (and
 * this code never trusts) a status of their own.
 *
 * FAIL CLOSED, NO FALLBACK: an earlier version of this file fell back to
 * JWT-only authentication whenever no status repository had been wired
 * (e.g. via a missing/failed setStatusRepo call). That was a genuine
 * production-safety defect: a wiring regression — routes/auth.js failing
 * to call setStatusRepo, or being refactored to skip it — would SILENTLY
 * disable account-status enforcement app-wide with no error, no log, and
 * no test failure to catch it, because JWT-only auth still "works" from
 * the caller's point of view. This version removes that fallback entirely:
 * whenever _statusRepo is not wired (null), authentication fails closed
 * with 401 for EVERY protected request, exactly the same as an active
 * repository error. There is no code path in this file where a bearer
 * token is accepted without a current, verified ACTIVE database record.
 *
 * `setStatusRepo(repo)` wires an identity repo (identityRepo -
 * findUserById + withTenant) into this module as a SINGLETON, the same
 * pattern already used by commands/auth.user.create.js (setRepo) and
 * core/commandBus.js (setUnitOfWork). routes/auth.js's build(deps) - the
 * router that already receives the real identityRepo from routes/api.js on
 * every real boot - calls it unconditionally on every build(), so
 * production always has a real repo wired well before any request is
 * served. Every router in the app that does `const { authentication } =
 * require('../middleware/authentication')` (the existing, unchanged import
 * used across the whole codebase) gets this enforcement via the shared
 * Node module cache, with zero changes to those router files, to
 * routes/api.js, or to index.js (both outside this phase's permitted file
 * scope).
 *
 * TEST ISOLATION: because this is a module-level singleton, a test file
 * that calls setStatusRepo directly (rather than only through
 * routes/auth.js's build()) MUST reset it (setStatusRepo(null)) in an
 * afterEach, or a later test in the SAME file could observe a repo wired
 * by an earlier one. node:test runs separate test FILES in separate
 * worker processes by default, so this singleton does not leak ACROSS
 * files — only within one file's own sequential test order, which is
 * exactly where a plain module-level variable is deterministic (tests in
 * one file run sequentially unless concurrency is explicitly requested).
 * Every Phase 67A test file that calls setStatusRepo directly does this
 * (see phase67a_authentication_status.test.js's `afterEach`).
 */

let _statusRepo = null;

/** @param {null | {withTenant: Function, findUserById: Function}} repo */
function setStatusRepo(repo) {
  _statusRepo = (repo && typeof repo.withTenant === 'function'
    && typeof repo.findUserById === 'function') ? repo : null;
}

/**
 * Look up the current, authoritative status for the JWT's subject. Returns
 * the user row on success, or throws/returns null on any condition that
 * must be rejected — callers must fail closed on anything other than a
 * row with status === 'ACTIVE'.
 */
async function _loadCurrentUser(claims) {
  if (!_statusRepo) {
    const err = new Error('authentication: no status repository wired');
    err.code = 'STATUS_REPO_NOT_WIRED';
    throw err;
  }
  let row = null;
  await _statusRepo.withTenant(claims.tenant_id, async (client) => {
    row = await _statusRepo.findUserById(claims.sub, client);
  });
  return row; // null covers "no such user" AND "soft-deleted" (findUserById filters soft_deleted_at IS NULL)
}

async function authentication(req, res, next) {
  const v = tokens.verifyAccessToken(req.get('authorization'));
  if (!v.ok) {
    return res.status(401).json({
      error: v.reason === 'no_token' ? 'authentication_required' : 'invalid_or_expired_token',
      requestId: req.requestId
    });
  }
  if (!v.claims || !v.claims.tenant_id || !v.claims.sub) {
    return res.status(401).json({ error: 'invalid_or_expired_token', requestId: req.requestId });
  }

  try {
    const row = await _loadCurrentUser(v.claims);
    if (!row || row.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'account_not_active', requestId: req.requestId });
    }
  } catch (err) {
    // Fail closed on ANY error — missing repo, repo error, or an
    // unexpected exception. Never falls through to treating an
    // unverifiable account as active. No internal detail (DB errors,
    // wiring state) is exposed to the client.
    logger.error({ err, user_id: v.claims.sub }, '[authentication] current-status check failed');
    return res.status(401).json({ error: 'authentication_required', requestId: req.requestId });
  }

  req.user = v.claims;
  next();
}

/**
 * Optional auth: routes that behave differently for anonymous vs
 * authenticated callers.
 *   - no token supplied: continues anonymously (req.user left undefined) —
 *     unchanged from before.
 *   - a token IS supplied: it must be a valid JWT for a currently ACTIVE
 *     account, exactly like `authentication` above. An invalid, expired,
 *     inactive, disabled, or terminated token is REJECTED with 401 — it is
 *     never silently downgraded to an anonymous request. Silently treating
 *     a presented-but-rejected credential as "no credential" would let a
 *     disabled account keep using an optionally-authenticated endpoint
 *     under an anonymous identity, which is exactly the kind of fail-open
 *     behaviour Workstream C exists to eliminate.
 */
async function optionalAuthentication(req, res, next) {
  const raw = req.get('authorization');
  if (!raw) { next(); return; }

  const v = tokens.verifyAccessToken(raw);
  if (!v.ok) {
    return res.status(401).json({
      error: v.reason === 'no_token' ? 'authentication_required' : 'invalid_or_expired_token',
      requestId: req.requestId
    });
  }
  if (!v.claims || !v.claims.tenant_id || !v.claims.sub) {
    return res.status(401).json({ error: 'invalid_or_expired_token', requestId: req.requestId });
  }

  try {
    const row = await _loadCurrentUser(v.claims);
    if (!row || row.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'account_not_active', requestId: req.requestId });
    }
  } catch (err) {
    logger.error({ err, user_id: v.claims.sub }, '[optionalAuthentication] current-status check failed');
    return res.status(401).json({ error: 'authentication_required', requestId: req.requestId });
  }

  req.user = v.claims;
  next();
}

module.exports = { authentication, optionalAuthentication, setStatusRepo };
