'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const env    = require('../config/env');

const USER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  LOCKED: 'LOCKED',
  DISABLED: 'DISABLED',
  PENDING_PASSWORD_RESET: 'PENDING_PASSWORD_RESET',
  TERMINATED: 'TERMINATED'
});

async function hashPassword(plain) {
  if (!plain || plain.length < 6) throw new Error('password_too_short');
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

// ---------------------------------------------------------------------------
// Phase 62A: T1/T2 login flow (active when repo.withTenant is available).
// Resolvers use SECURITY DEFINER functions (no GUC needed).
// T1 reads user + tenant status + password_hash (short read, no FOR UPDATE).
// bcrypt runs exactly once, outside all transactions.
// T2 re-selects FOR UPDATE, verifies hash unchanged, validates, inserts token.
// ---------------------------------------------------------------------------
async function _attemptLoginWithRLS(repo, opts) {
  const {
    tenantCode, propertyCode, propertyId: propIdArg,
    username, email, password,
    deviceName, deviceId, ipAddress, userAgent
  } = opts;

  const useEmailPath = !!(email && !username && !tenantCode && !propertyCode && !propIdArg);

  // A. Resolver — obtain user_id + tenant_id (no transaction, BYPASSRLS function)
  let resolvedUserId, resolvedTenantId, resolvedPropertyId;
  if (useEmailPath) {
    if (!repo.resolveByEmail) return { ok: false, reason: 'unknown_user' };
    const r = await repo.resolveByEmail(email);
    if (!r) return { ok: false, reason: 'unknown_user' };
    resolvedUserId = r.user_id; resolvedTenantId = r.tenant_id;
  } else if (tenantCode) {
    if (!repo.resolveByTenantUsername) return { ok: false, reason: 'unknown_user' };
    const r = await repo.resolveByTenantUsername(tenantCode, username);
    if (!r) return { ok: false, reason: 'unknown_user' };
    resolvedUserId = r.user_id; resolvedTenantId = r.tenant_id;
  } else if (propIdArg) {
    if (!repo.resolveByPropertyIdUsername) return { ok: false, reason: 'unknown_user' };
    const r = await repo.resolveByPropertyIdUsername(propIdArg, username);
    if (!r) return { ok: false, reason: 'unknown_user' };
    resolvedUserId = r.user_id; resolvedTenantId = r.tenant_id;
    resolvedPropertyId = r.property_id || propIdArg;
  } else {
    return { ok: false, reason: 'unknown_user' };
  }

  // B. T1 — read user + tenant status (no FOR UPDATE, commits immediately)
  let t1User = null, t1TenantStatus = null;
  await repo.withTenant(resolvedTenantId, async (client) => {
    t1User = await repo.findUserById(resolvedUserId, client);
    if (t1User && repo.findTenantStatus) {
      t1TenantStatus = await repo.findTenantStatus(resolvedTenantId, client);
    }
  }); // C. T1 commits

  if (!t1User) return { ok: false, reason: 'unknown_user' };
  if (t1TenantStatus && t1TenantStatus !== 'active') return { ok: false, reason: 'tenant_inactive' };
  if (t1User.status === USER_STATUS.DISABLED)   return { ok: false, reason: 'disabled' };
  if (t1User.status === USER_STATUS.TERMINATED) return { ok: false, reason: 'terminated' };
  if (t1User.status === USER_STATUS.LOCKED ||
      (t1User.locked_until && new Date(t1User.locked_until) > new Date())) {
    return { ok: false, reason: 'locked' };
  }
  const t1PasswordHash = t1User.password_hash;

  // D. bcrypt exactly once, OUTSIDE any transaction
  const verifyFn = repo._verifyPasswordFn || verifyPassword;
  const passwordOk = await verifyFn(password, t1PasswordHash);

  // E. Failed password — separate withTenant transaction
  if (!passwordOk) {
    try {
      await repo.withTenant(resolvedTenantId, async (client) => {
        await repo.updateUserOnFailedLogin(resolvedUserId, client);
      });
    } catch (_) { /* non-fatal */ }
    return { ok: false, reason: 'bad_password' };
  }

  // F. Generate raw refresh token and hash BEFORE T2 (never stored raw)
  const rawRefreshToken = crypto.randomBytes(32).toString('base64url');
  const refreshHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
  const refreshTtlDays = Number(env.REFRESH_TOKEN_TTL_DAYS) || 30;
  const refreshExpiresAt = new Date(Date.now() + refreshTtlDays * 86400 * 1000).toISOString();

  // G-N. T2 — lock, revalidate, authorize, update state, insert token (atomic)
  let t2User = null, roles = [], permissions = [], refreshTokenId = null;
  let primaryPropertyId = null, authorisedProperties = [];

  try {
    await repo.withTenant(resolvedTenantId, async (client) => {
      // G. Re-select user FOR UPDATE
      t2User = await repo.findUserById(resolvedUserId, client, { forUpdate: true });
      if (!t2User) throw Object.assign(new Error('user_gone'), { authReason: 'unknown_user' });

      // H. Verify password_hash unchanged from T1 (no bcrypt re-run)
      if (t2User.password_hash !== t1PasswordHash) {
        throw Object.assign(new Error('hash_changed'), { authReason: 'bad_password' });
      }

      // I. Revalidate tenant status, user status, locked_until
      if (repo.findTenantStatus) {
        const t2Tenant = await repo.findTenantStatus(resolvedTenantId, client);
        if (t2Tenant && t2Tenant !== 'active') {
          throw Object.assign(new Error('tenant_inactive'), { authReason: 'tenant_inactive' });
        }
      }
      if (t2User.status !== USER_STATUS.ACTIVE &&
          t2User.status !== USER_STATUS.PENDING_PASSWORD_RESET) {
        const r = t2User.status === USER_STATUS.LOCKED ? 'locked' : 'disabled';
        throw Object.assign(new Error(t2User.status), { authReason: r });
      }
      if (t2User.locked_until && new Date(t2User.locked_until) > new Date()) {
        throw Object.assign(new Error('locked'), { authReason: 'locked' });
      }

      // J. Property authorization (before login-state update or token insertion)
      if (resolvedPropertyId) {
        if (repo.findPropertyForAuth) {
          const prop = await repo.findPropertyForAuth(resolvedPropertyId, client);
          if (!prop || prop.tenant_id !== resolvedTenantId) {
            throw Object.assign(new Error('prop_access'), { authReason: 'property_access_denied' });
          }
          if (!prop.active) {
            throw Object.assign(new Error('prop_inactive'), { authReason: 'property_access_denied' });
          }
        }
        primaryPropertyId = resolvedPropertyId;
      } else {
        primaryPropertyId = t2User.primary_property_id;
      }

      // K. Load roles and permissions
      roles = await repo.findRolesForUser(resolvedUserId, client);
      permissions = await repo.findPermissionsForUser(resolvedUserId, client);

      // Verify property-scoped access after roles loaded
      if (resolvedPropertyId) {
        const has = roles.some((r) => r.property_id === resolvedPropertyId || r.property_id === null);
        if (!has) throw Object.assign(new Error('no_role_at_prop'), { authReason: 'property_access_denied' });
      }

      // Load accessible properties for email-path property selection
      if (useEmailPath && repo.listAccessibleProperties) {
        authorisedProperties = await repo.listAccessibleProperties(resolvedUserId, client);
      }

      // L. Update successful-login state
      await repo.updateUserOnSuccessfulLogin(resolvedUserId, client);

      // M. Insert initial refresh-token hash exactly once
      const rtRow = await repo.insertRefreshToken({
        user_id:     resolvedUserId,
        tenant_id:   resolvedTenantId,
        token_hash:  refreshHash,
        device_name: deviceName || null,
        device_id:   deviceId   || null,
        ip_address:  ipAddress  || null,
        user_agent:  userAgent  || null,
        expires_at:  refreshExpiresAt
      }, client);
      refreshTokenId = rtRow.id;
    }); // N. T2 commits
  } catch (err) {
    const reason = err.authReason;
    if (!reason) throw err; // unexpected — rethrow
    return { ok: false, reason };
  }

  const requiresPasswordChange = t2User.status === USER_STATUS.PENDING_PASSWORD_RESET;

  return {
    ok: true,
    login_via: useEmailPath ? 'email' : (tenantCode ? 'tenant_code' : (propIdArg ? 'property_id' : 'property_code')),
    user: {
      id:                  t2User.id,
      tenant_id:           resolvedTenantId,
      username:            t2User.username,
      email:               t2User.email,
      full_name:           t2User.full_name,
      primary_property_id: primaryPropertyId,
      status:              t2User.status
    },
    roles,
    permissions,
    // Passed back to auth route for access-token signing (O.) and compensating revoke (P.)
    refreshToken: {
      token:     rawRefreshToken,
      expiresAt: refreshExpiresAt,
      id:        refreshTokenId
    },
    requires_password_change: requiresPasswordChange,
    ...(useEmailPath ? {
      authorised_properties:        authorisedProperties,
      requires_property_selection:  authorisedProperties.length > 1
    } : {})
  };
}

/**
 * Login attempt. Returns:
 *   { ok:true, user, roles, permissions, refreshToken? }
 *   { ok:false, reason }
 *
 * Dispatches to the T1/T2 RLS-safe path when repo.withTenant + resolver
 * methods are available; falls back to the legacy pool-query path otherwise
 * (tests with in-memory repos, or callers without FORCE-RLS support).
 */
async function attemptLogin(repo, { tenantCode, propertyCode, propertyId, username, email, password,
                                     deviceName, deviceId, ipAddress, userAgent }) {
  if (!password) return { ok: false, reason: 'unknown_user' };

  // New RLS-safe path — always taken when repo has withTenant (production wiring).
  // Legacy pool-query methods (findUserByTenantUsername, etc.) are unreachable
  // via auth when withTenant is present; they only exist for in-memory test repos.
  if (repo.withTenant) {
    if (!(repo.resolveByTenantUsername || repo.resolveByEmail || repo.resolveByPropertyIdUsername)) {
      throw Object.assign(
        new Error('[auth] withTenant present but no resolvers — repo misconfigured'),
        { code: 'AUTH_REPO_MISCONFIGURED' }
      );
    }
    return _attemptLoginWithRLS(repo, { tenantCode, propertyCode, propertyId, username, email, password,
                                         deviceName, deviceId, ipAddress, userAgent });
  }

  // -------------------------------------------------------------------
  // Legacy path — only reachable from unit tests with in-memory fake repos
  // (repos that have no withTenant property). Never reached in production.
  // -------------------------------------------------------------------
  const useEmailPath = email && !username && !tenantCode && !propertyCode && !propertyId;
  if (useEmailPath) {
    if (!repo.findUserByEmailGlobal) return { ok: false, reason: 'unknown_user' };
    const row = await repo.findUserByEmailGlobal(email);
    if (!row) return { ok: false, reason: 'unknown_user' };
    if (row.tenant_status && row.tenant_status !== 'active') return { ok: false, reason: 'tenant_inactive' };
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
    const props = typeof repo.listAccessibleProperties === 'function'
      ? await repo.listAccessibleProperties(row.id) : [];
    const requiresPasswordChange = row.status === USER_STATUS.PENDING_PASSWORD_RESET;
    return {
      ok: true, login_via: 'email',
      user: { id: row.id, tenant_id: row.tenant_id, username: row.username, email: row.email,
              full_name: row.full_name, primary_property_id: row.primary_property_id, status: row.status },
      roles, permissions,
      authorised_properties: props,
      requires_property_selection: props.length > 1,
      requires_password_change: requiresPasswordChange
    };
  }

  if (!username) return { ok: false, reason: 'unknown_user' };

  // Legacy: validate exactly one of tenantCode/propertyCode
  if (tenantCode && propertyCode) return { ok: false, reason: 'invalid_login_identifiers' };
  if (!tenantCode && !propertyCode) return { ok: false, reason: 'invalid_login_identifiers' };

  // Legacy: determine path — property_id not supported here (needs resolver)
  let row, resolvedPropertyId = null;
  if (propertyCode) {
    if (!repo.findUserByPropertyCodeUsername) return { ok: false, reason: 'invalid_login_identifiers' };
    row = await repo.findUserByPropertyCodeUsername(propertyCode, username);
    if (row) resolvedPropertyId = row.resolved_property_id || row.primary_property_id || null;
  } else if (tenantCode) {
    row = await repo.findUserByTenantUsername(tenantCode, username);
  } else {
    return { ok: false, reason: 'invalid_login_identifiers' };
  }

  if (!row) return { ok: false, reason: 'unknown_user' };
  if (row.tenant_status && row.tenant_status !== 'active') return { ok: false, reason: 'tenant_inactive' };
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

  let primaryPropertyId = row.primary_property_id;
  if (propertyCode && resolvedPropertyId) {
    const has = roles.some((r) => r.property_id === resolvedPropertyId || r.property_id === null);
    if (!has) return { ok: false, reason: 'property_access_denied' };
    primaryPropertyId = resolvedPropertyId;
  }

  return {
    ok: true,
    login_via: propertyCode ? 'property_code' : 'tenant_code',
    user: { id: row.id, tenant_id: row.tenant_id, username: row.username, email: row.email,
            full_name: row.full_name, primary_property_id: primaryPropertyId, status: row.status },
    roles, permissions
  };
}

/**
 * Resolve a verified JWT subject back into the live user record + grants.
 * When repo.withTenant and tenantId are supplied, runs inside a tenant-scoped
 * transaction (required under FORCE RLS).
 * Falls back to legacy pool-query path when tenantId or withTenant is absent.
 */
async function resolveSession(repo, userId, tenantId) {
  if (repo.withTenant && tenantId) {
    let session = null;
    await repo.withTenant(tenantId, async (client) => {
      const row = await repo.findUserById(userId, client);
      if (!row) return;
      if (row.status !== USER_STATUS.ACTIVE && row.status !== USER_STATUS.PENDING_PASSWORD_RESET) return;
      const roles       = await repo.findRolesForUser(userId, client);
      const permissions = await repo.findPermissionsForUser(userId, client);
      session = {
        user: { id: row.id, tenant_id: row.tenant_id, username: row.username, email: row.email,
                full_name: row.full_name, primary_property_id: row.primary_property_id, status: row.status },
        roles, permissions
      };
    });
    return session;
  }

  // Legacy path
  const row = await repo.findUserById(userId);
  if (!row) return null;
  if (row.status !== USER_STATUS.ACTIVE && row.status !== USER_STATUS.PENDING_PASSWORD_RESET) return null;
  const roles       = await repo.findRolesForUser(userId);
  const permissions = await repo.findPermissionsForUser(userId);
  return {
    user: { id: row.id, tenant_id: row.tenant_id, username: row.username, email: row.email,
            full_name: row.full_name, primary_property_id: row.primary_property_id, status: row.status },
    roles, permissions
  };
}

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
