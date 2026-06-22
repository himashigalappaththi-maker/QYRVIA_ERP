'use strict';

const tokens = require('../services/tokens');
const logger = require('../config/logger');

/**
 * Authentication middleware. Extracts + verifies the JWT. On success,
 * attaches `req.user` with the claims:
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
 */
function authentication(req, res, next) {
  const v = tokens.verifyAccessToken(req.get('authorization'));
  if (!v.ok) {
    return res.status(401).json({
      error: v.reason === 'no_token' ? 'authentication_required' : 'invalid_or_expired_token',
      requestId: req.requestId
    });
  }
  req.user = v.claims;
  next();
}

/**
 * Optional auth (don't reject if no bearer). Used by routes that behave
 * differently for anonymous vs authenticated callers - not used in Phase 2
 * but exported for later phases.
 */
function optionalAuthentication(req, _res, next) {
  const v = tokens.verifyAccessToken(req.get('authorization'));
  if (v.ok) req.user = v.claims;
  next();
}

module.exports = { authentication, optionalAuthentication };
