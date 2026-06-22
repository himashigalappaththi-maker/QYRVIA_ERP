'use strict';

const bcrypt = require('bcryptjs');
const env    = require('../config/env');

/**
 * Identity service. All DB calls go through an injected `repo` so the
 * service is trivially unit-testable (tests pass an in-memory mock; the
 * production app passes a pg-backed implementation).
 *
 * repo contract:
 *   findUserByTenantUsername(tenantCode, username) => row | null
 *   findUserById(userId) => row | null
 *   findPermissionsForUser(userId) => string[] of permission codes
 *   findRolesForUser(userId) => [{ id, code, scope, property_id }]
 *   updateUserOnSuccessfulLogin(userId) => void
 *   updateUserOnFailedLogin(userId) => void   // bumps failed_login_count, locks at threshold
 *   insertUser({ tenant_id, username, email, password_hash, full_name, primary_property_id, status }) => row
 *   findPropertyBusinessDate(propertyId) => { current_business_date, business_date_locked }
 */

const USER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  LOCKED: 'LOCKED',
  DISABLED: 'DISABLED',
  PENDING_PASSWORD_RESET: 'PENDING_PASSWORD_RESET',
  TERMINATED: 'TERMINATED'
});

async function hashPassword(plain) {
  if (!plain || plain.length < 6) throw new Error('password_too_short');
  const rounds = env.BCRYPT_ROUNDS;
  return bcrypt.hash(plain, rounds);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Login attempt - returns one of:
 *   { ok:true, user, roles, permissions }
 *   { ok:false, reason: 'unknown_user' | 'bad_password' | 'disabled' | 'locked' | 'terminated' | 'tenant_inactive' }
 *
 * Caller (the auth route) is responsible for audit-logging the outcome.
 */
async function attemptLogin(repo, { tenantCode, propertyCode, username, password }) {
  if (!username || !password) {
    return { ok: false, reason: 'unknown_user' };
  }
  // Phase 6 / C3: exactly one identifier must be supplied.
  if ((tenantCode && propertyCode) || (!tenantCode && !propertyCode)) {
    return { ok: false, reason: 'invalid_login_identifiers' };
  }
  let row;
  let resolvedPropertyId = null;
  if (propertyCode) {
    if (!repo.findUserByPropertyCodeUsername) {
      return { ok: false, reason: 'invalid_login_identifiers' };
    }
    row = await repo.findUserByPropertyCodeUsername(propertyCode, username);
    if (row) resolvedPropertyId = row.resolved_property_id || row.primary_property_id || null;
  } else {
    row = await repo.findUserByTenantUsername(tenantCode, username);
  }
  if (!row) return { ok: false, reason: 'unknown_user' };

  if (row.tenant_status && row.tenant_status !== 'active') {
    return { ok: false, reason: 'tenant_inactive' };
  }
  if (row.status === USER_STATUS.DISABLED)   return { ok: false, reason: 'disabled' };
  if (row.status === USER_STATUS.TERMINATED) return { ok: false, reason: 'terminated' };
  if (row.status === USER_STATUS.LOCKED || (row.locked_until && new Date(row.locked_until) > new Date())) {
    return { ok: false, reason: 'locked' };
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    if (repo.updateUserOnFailedLogin) await repo.updateUserOnFailedLogin(row.id);
    return { ok: false, reason: 'bad_password' };
  }

  if (repo.updateUserOnSuccessfulLogin) await repo.updateUserOnSuccessfulLogin(row.id);

  const roles       = await repo.findRolesForUser(row.id);
  const permissions = await repo.findPermissionsForUser(row.id);

  // Phase 6 / C3: when login was via property_code, validate that the user
  // holds at least one role at the resolved property OR a tenant-wide role.
  let primaryPropertyId = row.primary_property_id;
  if (propertyCode && resolvedPropertyId) {
    const has = roles.some((r) => r.property_id === resolvedPropertyId || r.property_id === null);
    if (!has) return { ok: false, reason: 'property_access_denied' };
    primaryPropertyId = resolvedPropertyId;
  }

  return {
    ok: true,
    login_via: propertyCode ? 'property_code' : 'tenant_code',
    user: {
      id:                  row.id,
      tenant_id:           row.tenant_id,
      username:            row.username,
      email:               row.email,
      full_name:           row.full_name,
      primary_property_id: primaryPropertyId,
      status:              row.status
    },
    roles,
    permissions
  };
}

/**
 * Resolve a verified JWT subject back into the live user record + grants.
 * Returns { user, roles, permissions } or null if the user no longer exists
 * or is no longer ACTIVE / PENDING_PASSWORD_RESET.
 */
async function resolveSession(repo, userId) {
  const row = await repo.findUserById(userId);
  if (!row) return null;
  if (row.status !== USER_STATUS.ACTIVE && row.status !== USER_STATUS.PENDING_PASSWORD_RESET) return null;
  const roles       = await repo.findRolesForUser(userId);
  const permissions = await repo.findPermissionsForUser(userId);
  return {
    user: {
      id:                  row.id,
      tenant_id:           row.tenant_id,
      username:            row.username,
      email:               row.email,
      full_name:           row.full_name,
      primary_property_id: row.primary_property_id,
      status:              row.status
    },
    roles,
    permissions
  };
}

/**
 * Check whether a role/permission set satisfies a required check.
 * - hasRole: at least one of codes is present
 * - hasPermission: permission code is present, OR super_admin role is present (implicit bypass)
 */
function hasRole(roles, ...codes) {
  if (!Array.isArray(roles) || !codes.length) return false;
  const have = new Set(roles.map((r) => r.code));
  return codes.some((c) => have.has(c));
}
function hasPermission(roles, permissions, permCode) {
  if (hasRole(roles, 'super_admin')) return true;
  if (!Array.isArray(permissions)) return false;
  return permissions.indexOf(permCode) >= 0;
}

module.exports = {
  USER_STATUS,
  hashPassword,
  verifyPassword,
  attemptLogin,
  resolveSession,
  hasRole,
  hasPermission
};
