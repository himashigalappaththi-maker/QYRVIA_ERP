'use strict';

/**
 * Composes the canonical `req.ctx` object from data the upstream middleware
 * stashed. Runs AFTER requestId + tenantContext (or after authentication +
 * identityContext on protected routes).
 *
 *   req.ctx = { requestId, tenantId, propertyId, actorId, actorName }
 *
 * Phase 2: actorId/actorName auto-populate from req.user if the JWT path ran.
 * On unauthenticated routes (health, auth), they're null.
 */
function requestContext(req, res, next) {
  // Skip if identityContext already built a richer ctx (it's frozen).
  if (req.ctx) return next();

  req.ctx = Object.freeze({
    requestId:  req.requestId  || null,
    tenantId:   req.tenantId   || (req.user && req.user.tenant_id) || null,
    propertyId: req.propertyId || (req.user && req.user.primary_property_id) || null,
    actorId:    (req.user && req.user.sub)        || req.actorId   || null,
    actorName:  (req.user && req.user.full_name)  || null
  });
  next();
}

module.exports = requestContext;
