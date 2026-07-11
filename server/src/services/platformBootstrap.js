'use strict';

const identity = require('./identity');

/**
 * Idempotent Platform Super Admin bootstrap service.
 *
 * Called from provision-platform-admin.js (CLI) and testable in unit tests via
 * in-memory repo adapters.
 *
 * repo contract:
 *   findUserByEmailGlobal(email)          → row | null
 *   insertUser({ tenant_id, username, email, password_hash, full_name, status }) → row
 *   ensureSuperAdminRole(userId, tenantId) → void  (idempotent — ON CONFLICT DO NOTHING in DB)
 *   insertAuditEvent?(ev)                  → void  (optional — non-fatal if absent)
 *
 * Idempotency rules:
 *   - User already ACTIVE            → skip password; only ensure role; action='already_active'
 *   - User already PENDING_PASSWORD_RESET → skip password; only ensure role; action='pending_first_login'
 *   - User doesn't exist             → create with hashed password + PENDING_PASSWORD_RESET; action='created'
 *
 * SECURITY: password is hashed with bcrypt before any storage. It is never logged.
 */
async function bootstrapPlatformAdmin({ email, password, fullName = 'Platform Super Admin', tenantId }, repo) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
    return { ok: false, error: 'invalid_email' };
  }
  if (!password || String(password).length < 8) {
    return { ok: false, error: 'password_too_short' };
  }
  if (!tenantId) {
    return { ok: false, error: 'tenant_id_required' };
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  let user = await repo.findUserByEmailGlobal(normalizedEmail);
  let action;

  if (!user) {
    const passwordHash = await identity.hashPassword(String(password));
    const username = normalizedEmail.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
    user = await repo.insertUser({
      tenant_id: tenantId,
      username,
      email: normalizedEmail,
      password_hash: passwordHash,
      full_name: fullName,
      status: 'PENDING_PASSWORD_RESET'
    });
    action = 'created';
  } else if (user.status === 'ACTIVE') {
    // User has already changed their password. Never overwrite it.
    action = 'already_active';
  } else if (user.status === 'PENDING_PASSWORD_RESET') {
    // User exists but hasn't logged in yet. Leave password alone.
    action = 'pending_first_login';
  } else {
    action = 'exists_' + user.status;
  }

  await repo.ensureSuperAdminRole(user.id, tenantId);

  if (typeof repo.insertAuditEvent === 'function') {
    try {
      await repo.insertAuditEvent({
        tenant_id: tenantId,
        event_type: 'platform.super_admin_provisioned',
        aggregate_type: 'user',
        aggregate_id: user.id,
        actor_id: user.id,
        payload: JSON.stringify({ action, email: normalizedEmail, provisioned_via: 'bootstrapPlatformAdmin' })
      });
    } catch (_) { /* non-fatal */ }
  }

  return {
    ok: true,
    action,
    userId: user.id,
    tenantId,
    email: normalizedEmail,
    status: user.status
  };
}

module.exports = { bootstrapPlatformAdmin };
