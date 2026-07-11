'use strict';

const logger = require('../config/logger');

/**
 * Authorization middleware factories.
 *
 *   requireRole('corporate_admin', 'finance_manager')
 *   requirePermission('reservation.create')
 *
 * Super Admin bypasses requirePermission (but not requireRole - if you ask
 * for finance_manager specifically, super_admin doesn't have that grant).
 *
 * The authentication middleware must have already run (so req.user exists).
 * The identityContext middleware must have populated req.ctx.permissions for
 * requirePermission to work.
 */

/**
 * Explicit platform-level role guard.
 *
 * Fails closed: only callers with super_admin or platform_admin in their JWT
 * role_codes proceed. Every other role — including corporate_admin, property_admin,
 * company_admin, and all operational roles — receives 403.
 *
 * Must run AFTER authentication middleware (req.user must exist).
 * Note: authentication middleware already returns 401 for missing/invalid tokens,
 * so by the time requirePlatformRole runs the caller is always authenticated.
 */
function requirePlatformRole() {
  return function (req, res, next) {
    const userRoles = (req.user && req.user.role_codes) || [];
    const allowed = userRoles.includes('super_admin') || userRoles.includes('platform_admin');
    if (!allowed) {
      _auditDeny(req, 'role', ['super_admin', 'platform_admin']);
      return res.status(403).json({
        error: 'platform_role_required',
        required: ['super_admin', 'platform_admin'],
        requestId: req.requestId
      });
    }
    next();
  };
}

function requireRole(...codes) {
  if (!codes.length) throw new Error('requireRole: at least one role code required');
  return function (req, res, next) {
    const userRoles = (req.user && req.user.role_codes) || [];
    const ok = codes.some((c) => userRoles.includes(c));
    if (!ok) {
      _auditDeny(req, 'role', codes);
      return res.status(403).json({
        error: 'role_required',
        required: codes,
        requestId: req.requestId
      });
    }
    next();
  };
}

function requirePermission(permCode) {
  if (!permCode || typeof permCode !== 'string') throw new Error('requirePermission: permCode required');
  return function (req, res, next) {
    const isSuper     = ((req.user && req.user.role_codes) || []).includes('super_admin');
    const permissions = (req.ctx && req.ctx.permissions) || [];
    if (isSuper || permissions.includes(permCode)) return next();
    _auditDeny(req, 'permission', permCode);
    return res.status(403).json({
      error: 'permission_denied',
      required: permCode,
      requestId: req.requestId
    });
  };
}

function _auditDeny(req, kind, required) {
  // Log only; the audit pipeline writes the row when the command flows
  // through commandBus. Direct middleware denies are logged at WARN so
  // operators can spot probe attempts.
  logger.warn({
    request_id: req.requestId,
    user_id:    req.user && req.user.sub,
    tenant_id:  req.user && req.user.tenant_id,
    kind, required
  }, '[authz] denied');
}

module.exports = { requirePlatformRole, requireRole, requirePermission };
