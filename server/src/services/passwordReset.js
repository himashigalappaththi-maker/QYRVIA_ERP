'use strict';

const crypto   = require('crypto');
const identity = require('./identity');

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

function generateResetToken() {
  const raw  = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * buildPasswordResetService({ repo })
 *
 * repo contract:
 *   findUserByEmailGlobal(email) => row | null
 *   insertPasswordResetToken({ user_id, tenant_id, token_hash, expires_at }) => row
 *   findPasswordResetToken(tokenHash) => row | null
 *   markPasswordResetTokenUsed(id) => void
 *   updateUserPassword(userId, passwordHash) => void
 *   revokeAllRefreshTokensForUser(userId) => void
 *   revokeActivePasswordResetTokensForUser(userId) => void  (optional)
 */
function buildPasswordResetService({ repo }) {

  /**
   * Request a password reset.
   * ALWAYS returns { ok: true } to prevent email enumeration.
   * rawToken is returned only when a matching user is found — caller queues
   * it for delivery and must never log it.
   */
  async function requestReset({ email }) {
    if (!email) return { ok: true, queued: false };
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      return { ok: true, queued: false };
    }

    const user = typeof repo.findUserByEmailGlobal === 'function'
      ? await repo.findUserByEmailGlobal(normalizedEmail)
      : null;

    if (!user) return { ok: true, queued: false };

    if (user.status === 'DISABLED' || user.status === 'TERMINATED') {
      return { ok: true, queued: false };
    }

    if (typeof repo.revokeActivePasswordResetTokensForUser === 'function') {
      await repo.revokeActivePasswordResetTokensForUser(user.id);
    }

    const { raw, hash } = generateResetToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);
    await repo.insertPasswordResetToken({
      user_id:    user.id,
      tenant_id:  user.tenant_id,
      token_hash: hash,
      expires_at: expiresAt
    });

    return { ok: true, queued: true, userId: user.id, rawToken: raw, email: normalizedEmail, expiresAt };
  }

  async function completeReset({ token, newPassword }) {
    if (!token || !newPassword) return { ok: false, error: 'missing_fields' };
    if (String(newPassword).length < 8) {
      return { ok: false, error: 'password_too_short', detail: 'Minimum 8 characters.' };
    }

    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const record = await repo.findPasswordResetToken(hash);

    if (!record)                     return { ok: false, error: 'reset_token_invalid' };
    if (record.status !== 'pending') return { ok: false, error: 'reset_token_used' };
    if (new Date(record.expires_at) < new Date()) return { ok: false, error: 'reset_token_expired' };

    const passwordHash = await identity.hashPassword(newPassword);
    await repo.updateUserPassword(record.user_id, passwordHash);
    await repo.markPasswordResetTokenUsed(record.id);

    if (typeof repo.revokeAllRefreshTokensForUser === 'function') {
      await repo.revokeAllRefreshTokensForUser(record.user_id);
    }

    return { ok: true };
  }

  return { requestReset, completeReset };
}

module.exports = { buildPasswordResetService };
