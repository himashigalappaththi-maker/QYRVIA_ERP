'use strict';

const logger = require('../config/logger');

/**
 * Identity context middleware. Replaces the Phase 1 header-trust path.
 *
 *   - Reads tenant_id, primary_property_id, actor (= user) from `req.user`
 *     (set by authentication middleware).
 *   - Optional X-Property-Id override: if the user passes one, it must be
 *     a UUID. Cross-tenant property assignments are validated by the route
 *     handlers when they query the DB - RLS makes cross-tenant rows invisible.
 *   - Attaches the canonical `req.ctx` and the helper accessor fields the
 *     downstream code reads (tenantId, propertyId, actorId, actorName,
 *     permissions, roleCodes).
 *
 * Spoof check: if X-Tenant-Id is supplied and does NOT match the JWT
 * tenant_id, log a WARN-level audit hint. The header is IGNORED regardless.
 */

const HEADER_TENANT   = 'x-tenant-id';
const HEADER_PROPERTY = 'x-property-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Build the middleware. `repo` is the session repository for resolving
 * up-to-date permissions on each request. If not supplied, permissions are
 * empty (will rely on the JWT's role_codes only for requirePermission).
 *
 *   @param {object} repo - { findPermissionsForUser(userId), findPropertyBusinessDate(propertyId) }
 */
function identityContext(repo) {
  return async function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'authentication_required', requestId: req.requestId });
    }

    // Spoof detection: header tenant must match token tenant (or be absent).
    const headerTenant = req.get(HEADER_TENANT);
    if (headerTenant && headerTenant !== req.user.tenant_id) {
      logger.warn({
        request_id: req.requestId,
        user_id:    req.user.sub,
        header_tenant: headerTenant,
        token_tenant:  req.user.tenant_id
      }, '[identity] X-Tenant-Id mismatch with token; header ignored');
    }

    // Optional property override - must be UUID; cross-tenant access blocked by RLS.
    let propertyId = req.user.primary_property_id || null;
    const headerProperty = req.get(HEADER_PROPERTY);
    if (headerProperty) {
      if (!UUID_RE.test(headerProperty)) {
        return res.status(400).json({ error: 'x_property_id_invalid', requestId: req.requestId });
      }
      propertyId = headerProperty;
    }

    // Resolve permissions (Phase 2 reads from repo; JWT carries role_codes
    // but not permission codes - those change without the user re-logging in)
    let permissions = [];
    if (repo && typeof repo.findPermissionsForUser === 'function') {
      try {
        permissions = await repo.findPermissionsForUser(req.user.sub);
      } catch (err) {
        logger.error({ err, user_id: req.user.sub }, '[identity] permission lookup failed');
        return res.status(500).json({ error: 'permission_lookup_failed', requestId: req.requestId });
      }
    }

    // Mirror onto plain fields the legacy code reads
    req.tenantId   = req.user.tenant_id;
    req.propertyId = propertyId;
    req.actorId    = req.user.sub;

    req.ctx = Object.freeze({
      requestId:   req.requestId,
      tenantId:    req.user.tenant_id,
      propertyId:  propertyId,
      actorId:     req.user.sub,
      actorName:   req.user.full_name || null,
      roleCodes:   req.user.role_codes || [],
      roleIds:     req.user.role_ids   || [],
      permissions: permissions,
      businessDate: null  // populated by businessDate middleware if mounted
    });

    next();
  };
}

module.exports = { identityContext };
