'use strict';

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const env    = require('../config/env');

const ACCESS_TTL  = env.ACCESS_TOKEN_TTL_SEC;
const REFRESH_TTL = env.REFRESH_TOKEN_TTL_DAYS;
const PRIMARY     = env.JWT_SECRET;
const PREV        = env.JWT_SECRET_PREV;
const ALG         = 'HS256';
const ISS         = 'qyrvia-server';

function _sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function _genOpaque() {
  return crypto.randomBytes(32).toString('base64url');
}

function _now() { return Math.floor(Date.now() / 1000); }

function issueAccessToken({ userId, tenantId, primaryPropertyId, roleCodes, roleIds }) {
  if (!userId)   throw new Error('issueAccessToken: userId required');
  if (!tenantId) throw new Error('issueAccessToken: tenantId required');
  const jti = crypto.randomUUID();
  const iat = _now();
  const exp = iat + ACCESS_TTL;
  const payload = {
    sub:                  userId,
    tenant_id:            tenantId,
    primary_property_id:  primaryPropertyId || null,
    role_codes:           roleCodes || [],
    role_ids:             roleIds   || [],
    jti, iat, exp,
    iss:                  ISS
  };
  const token = jwt.sign(payload, PRIMARY, { algorithm: ALG });
  return { token, expiresAt: new Date(exp * 1000).toISOString(), jti };
}

function _extractBearer(authHeader) {
  if (!authHeader) return null;
  const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function verifyAccessToken(authHeader) {
  const raw = _extractBearer(authHeader);
  if (!raw) return { ok: false, reason: 'no_token' };
  const tryVerify = (secret) => {
    try { return jwt.verify(raw, secret, { algorithms: [ALG], issuer: ISS }); }
    catch (_) { return null; }
  };
  let claims = tryVerify(PRIMARY);
  if (!claims && PREV) claims = tryVerify(PREV);
  if (!claims) return { ok: false, reason: 'invalid_or_expired' };
  return { ok: true, claims };
}

/**
 * Issue a refresh token and persist its hash.
 * When client is provided, uses it (e.g. inside a withTenant transaction).
 * Legacy callers omit client; the fake repo ignores the missing arg.
 */
async function issueRefreshToken(repo, { userId, tenantId, deviceName, deviceId, ipAddress, userAgent }, client) {
  if (!userId)   throw new Error('issueRefreshToken: userId required');
  if (!tenantId) throw new Error('issueRefreshToken: tenantId required');
  const raw  = _genOpaque();
  const hash = _sha256hex(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL * 86400 * 1000).toISOString();
  const row = await repo.insertRefreshToken({
    user_id:     userId,
    tenant_id:   tenantId,
    token_hash:  hash,
    device_name: deviceName || null,
    device_id:   deviceId   || null,
    ip_address:  ipAddress  || null,
    user_agent:  userAgent  || null,
    expires_at:  expiresAt
  }, client);
  return { token: raw, hash, expiresAt, id: row.id };
}

// ---------------------------------------------------------------------------
// Phase 62A: RLS-safe rotation — uses resolver + withTenant atomically.
// ---------------------------------------------------------------------------
async function _rotateWithRLS(repo, hash, ctx, emitSecurityEvent) {
  // B. Resolve token_id, tenant_id, user_id (no transaction, BYPASSRLS function)
  const resolved = await repo.resolveRefreshTokenByHash(hash);
  if (!resolved) return { ok: false, reason: 'invalid_token' };

  const { token_id, tenant_id, user_id } = resolved;
  let result = null;

  // C. Open withTenant (atomic transaction for all mutations)
  await repo.withTenant(tenant_id, async (client) => {
    // D. Re-select token by ID, tenant and hash FOR UPDATE
    const tokenRow = await repo.findRefreshTokenByIdAndHash(token_id, hash, client);
    if (!tokenRow) { result = { ok: false, reason: 'invalid_token' }; return; }

    // E. Revalidate: rotated_to (already used), revoked_at (explicitly revoked), expires_at
    if (tokenRow.rotated_to || tokenRow.revoked_at) {
      // Reuse detected — revoke all active tokens for this user within the tenant
      await repo.revokeAllRefreshTokensForUser(user_id, client);
      // G. Return sentinel; commit (containment committed before reused is returned)
      result = { ok: false, reason: 'token_reuse_detected', _committed: true };
      return;
    }
    if (new Date(tokenRow.expires_at) <= new Date()) {
      result = { ok: false, reason: 'token_expired' };
      return;
    }

    // Valid token — F. generate replacement, preserve device metadata
    const rawNew    = _genOpaque();
    const hashNew   = _sha256hex(rawNew);
    const expiresAt = new Date(Date.now() + Number(REFRESH_TTL) * 86400 * 1000).toISOString();
    const nowIso    = new Date().toISOString();

    const freshRow = await repo.insertRefreshToken({
      user_id:     tokenRow.user_id,
      tenant_id:   tokenRow.tenant_id,
      token_hash:  hashNew,
      device_name: (ctx && ctx.deviceName) || tokenRow.device_name,
      device_id:   (ctx && ctx.deviceId)   || tokenRow.device_id,
      ip_address:  (ctx && ctx.ipAddress)  || tokenRow.ip_address,
      user_agent:  (ctx && ctx.userAgent)  || tokenRow.user_agent,
      expires_at:  expiresAt
    }, client);

    await repo.linkRotation(token_id, freshRow.id, client);
    await repo.revokeRefreshToken(token_id, nowIso, client);
    await repo.markRefreshTokenUsed(token_id, nowIso, client);

    result = {
      ok:         true,
      newRefresh: { token: rawNew, expiresAt, id: freshRow.id },
      userId:     tokenRow.user_id,
      tenantId:   tokenRow.tenant_id
    };
  }); // commit

  // Emit security event for reuse after commit
  if (result && result.reason === 'token_reuse_detected') {
    if (emitSecurityEvent) {
      try { emitSecurityEvent({ type: 'auth.refresh_reuse', userId: user_id, tenantId: tenant_id }); }
      catch (_) {}
    }
    return { ok: false, reason: 'token_reuse_detected' };
  }

  return result;
}

/**
 * Rotate a presented refresh token.
 * Returns { ok:true, newRefresh, userId, tenantId } or { ok:false, reason }.
 *
 * Dispatches to the RLS-safe path when repo.withTenant + resolver are present;
 * falls back to the legacy path for tests with in-memory repos.
 */
async function rotateRefreshToken(repo, presented, ctx, emitSecurityEvent) {
  if (!presented) return { ok: false, reason: 'invalid' };
  const hash = _sha256hex(presented);

  // RLS-safe path — always taken in production (repo always has withTenant).
  // Fail closed: if withTenant present but resolver missing, the repo is
  // misconfigured; throw rather than fall through to broken pool-query path.
  if (repo.withTenant) {
    if (!repo.resolveRefreshTokenByHash) {
      throw Object.assign(
        new Error('[tokens] withTenant present but resolveRefreshTokenByHash missing — repo misconfigured'),
        { code: 'TOKENS_REPO_MISCONFIGURED' }
      );
    }
    return _rotateWithRLS(repo, hash, ctx, emitSecurityEvent);
  }

  // Legacy path (in-memory repos, no FORCE RLS — unit tests only)
  const row = await repo.findRefreshTokenByHash(hash);
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) {
    if (repo.revokeChainFrom) await repo.revokeChainFrom(row.id, new Date().toISOString());
    return { ok: false, reason: 'reused' };
  }
  if (row.rotated_to) return { ok: false, reason: 'reused' };
  if (new Date(row.expires_at) <= new Date()) return { ok: false, reason: 'expired' };

  const nowIso = new Date().toISOString();
  if (repo.markRefreshTokenUsed) await repo.markRefreshTokenUsed(row.id, nowIso);
  await repo.revokeRefreshToken(row.id, nowIso);
  const fresh = await issueRefreshToken(repo, {
    userId:     row.user_id,
    tenantId:   row.tenant_id,
    deviceName: (ctx && ctx.deviceName) || row.device_name,
    deviceId:   (ctx && ctx.deviceId)   || row.device_id,
    ipAddress:  (ctx && ctx.ipAddress)  || row.ip_address,
    userAgent:  (ctx && ctx.userAgent)  || row.user_agent
  });
  if (repo.linkRotation) await repo.linkRotation(row.id, fresh.id);
  return { ok: true, newRefresh: fresh, userId: row.user_id, tenantId: row.tenant_id };
}

/**
 * Revoke a presented refresh token.
 * RLS-safe path uses resolver + withTenant; legacy path for test repos.
 */
async function revokeRefreshToken(repo, presented) {
  if (!presented) return { ok: false, reason: 'invalid' };
  const hash = _sha256hex(presented);

  // RLS-safe path
  if (repo.withTenant && repo.resolveRefreshTokenByHash) {
    const resolved = await repo.resolveRefreshTokenByHash(hash);
    if (!resolved) return { ok: true }; // already gone — idempotent
    await repo.withTenant(resolved.tenant_id, async (client) => {
      const row = await repo.findRefreshTokenByHash(hash, client);
      if (row && !row.revoked_at) {
        await repo.revokeRefreshToken(row.id, new Date().toISOString(), client);
      }
    });
    return { ok: true };
  }

  // Legacy path
  const row = await repo.findRefreshTokenByHash(hash);
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) return { ok: true };
  await repo.revokeRefreshToken(row.id, new Date().toISOString());
  return { ok: true };
}

module.exports = {
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  // test exports
  _sha256hex,
  _genOpaque
};
