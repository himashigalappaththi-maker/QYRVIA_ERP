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
 * buildPasswordResetService({ repo, identityNotificationOutbox, withTenantFn })
 *
 * repo contract:
 *   findUserByEmailGlobal(email) => row | null
 *   revokeActivePasswordResetTokensForUser(userId, client) => void
 *   insertPasswordResetToken(rec, client) => row
 *   findPasswordResetToken(tokenHash) => row | null
 *   markPasswordResetTokenUsed(id) => void
 *   updateUserPassword(userId, passwordHash) => void
 *   revokeAllRefreshTokensForUser(userId) => void
 *
 * identityNotificationOutbox.enqueuePasswordResetNotification(data, client)
 * withTenantFn: established tenant-scoped transaction helper (BEGIN/COMMIT/ROLLBACK)
 */
function buildPasswordResetService({ repo, identityNotificationOutbox, withTenantFn }) {
  if (
    !identityNotificationOutbox ||
    typeof identityNotificationOutbox.enqueuePasswordResetNotification !== 'function'
  ) {
    const err = new Error('identityNotificationOutbox with enqueuePasswordResetNotification required');
    err.code = 'OUTBOX_REQUIRED';
    throw err;
  }
  if (typeof withTenantFn !== 'function') {
    const err = new Error('withTenantFn required');
    err.code = 'WITH_TENANT_REQUIRED';
    throw err;
  }

  /**
   * Request a password reset.
   * ALWAYS returns { ok: true } — prevents email enumeration.
   * For a known active identity, revocation + token insertion + notification
   * enqueue are all committed atomically inside one tenant-scoped transaction.
   */
  async function requestReset({ email }) {
    if (!email) return { ok: true };
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      return { ok: true };
    }

    const user = typeof repo.findUserByEmailGlobal === 'function'
      ? await repo.findUserByEmailGlobal(normalizedEmail)
      : null;

    if (!user) return { ok: true };

    if (user.status === 'DISABLED' || user.status === 'TERMINATED') {
      return { ok: true };
    }

    const { raw, hash } = generateResetToken();
    const calculatedExpiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

    await withTenantFn(user.tenant_id, async (client) => {
      await repo.revokeActivePasswordResetTokensForUser(user.id, client);

      const insertedRec = await repo.insertPasswordResetToken({
        user_id:    user.id,
        tenant_id:  user.tenant_id,
        token_hash: hash,
        expires_at: calculatedExpiresAt
      }, client);

      if (!insertedRec || !insertedRec.id) {
        const err = new Error('Password reset record creation failed');
        err.code = 'PASSWORD_RESET_RECORD_MISSING';
        throw err;
      }

      await identityNotificationOutbox.enqueuePasswordResetNotification({
        tenantId:      user.tenant_id,
        identityId:    user.id,
        resetRecordId: String(insertedRec.id),
        email:         user.email,
        rawToken:      raw,
        expiresAt:     insertedRec.expires_at || calculatedExpiresAt
      }, client);
    });

    return { ok: true };
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
