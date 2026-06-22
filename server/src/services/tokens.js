'use strict';

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const env    = require('../config/env');

/**
 * Tokens service.
 *
 *   issueAccessToken({ userId, tenantId, primaryPropertyId, roleCodes, roleIds })
 *     => { token, expiresAt, jti }
 *
 *   verifyAccessToken(rawHeader) => { ok:true, claims } | { ok:false, reason }
 *
 *   issueRefreshToken(repo, { userId, tenantId, ttlDays, deviceName, deviceId, ipAddress, userAgent })
 *     => { token, hash, expiresAt, id }
 *
 *   rotateRefreshToken(repo, presented, ctx) => { ok, newToken?, reason? }
 *
 *   revokeRefreshToken(repo, presented) => { ok, reason? }
 *
 * Refresh tokens are opaque 256-bit random strings (base64url). We store only
 * sha256(token) in the DB and compare hashes - the raw token never lands in
 * persistent storage.
 *
 * repo contract (refresh token operations):
 *   insertRefreshToken({ user_id, tenant_id, token_hash, device_name, device_id,
 *                        ip_address, user_agent, expires_at }) => row
 *   findActiveRefreshTokenByHash(hash)  => row | null
 *   markRefreshTokenUsed(id, ts)        => void
 *   revokeRefreshToken(id, ts)          => void
 *   revokeChainFrom(id, ts)             => void   // for reuse-detection
 *   linkRotation(oldId, newId)          => void
 */

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

async function issueRefreshToken(repo, { userId, tenantId, deviceName, deviceId, ipAddress, userAgent }) {
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
  });
  return { token: raw, hash, expiresAt, id: row.id };
}

/**
 * Rotate a presented refresh token. Returns:
 *   { ok:true, newRefresh:{token, ...}, userId, tenantId }
 *   { ok:false, reason: 'invalid' | 'expired' | 'revoked' | 'reused' }
 *
 * Reuse detection: if the presented hash maps to a row that's already revoked,
 * we revoke the entire chain (forces re-login on all devices). This signals
 * that someone exfiltrated the token.
 */
async function rotateRefreshToken(repo, presented, ctx) {
  if (!presented) return { ok: false, reason: 'invalid' };
  const hash = _sha256hex(presented);
  const row  = await repo.findRefreshTokenByHash(hash);
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) {
    // Reuse signal: revoke the whole chain
    if (repo.revokeChainFrom) await repo.revokeChainFrom(row.id, new Date().toISOString());
    return { ok: false, reason: 'reused' };
  }
  if (new Date(row.expires_at) <= new Date()) return { ok: false, reason: 'expired' };

  // Mark old token used + revoked; issue fresh one; link the chain.
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

async function revokeRefreshToken(repo, presented) {
  if (!presented) return { ok: false, reason: 'invalid' };
  const row = await repo.findRefreshTokenByHash(_sha256hex(presented));
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) return { ok: true }; // idempotent
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
