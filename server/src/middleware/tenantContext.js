'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reads `X-Tenant-Id` and `X-Property-Id` headers and validates UUID shape.
 * Attaches to `req.tenantId` / `req.propertyId` for the requestContext
 * middleware to compose into `req.ctx`.
 *
 * Tenant is REQUIRED unless the route opts out via `req._skipTenant = true`.
 * The health router sets that flag.
 */
const HEADER_TENANT   = 'x-tenant-id';
const HEADER_PROPERTY = 'x-property-id';

function tenantContext(req, res, next) {
  if (req._skipTenant) return next();

  const tenant = req.get(HEADER_TENANT);
  if (!tenant) {
    return res.status(400).json({
      error: 'x_tenant_id_required',
      detail: 'Missing X-Tenant-Id header',
      requestId: req.requestId
    });
  }
  if (!UUID_RE.test(tenant)) {
    return res.status(400).json({
      error: 'x_tenant_id_invalid',
      detail: 'X-Tenant-Id must be a UUID',
      requestId: req.requestId
    });
  }
  req.tenantId = tenant;

  const property = req.get(HEADER_PROPERTY);
  if (property) {
    if (!UUID_RE.test(property)) {
      return res.status(400).json({
        error: 'x_property_id_invalid',
        detail: 'X-Property-Id must be a UUID',
        requestId: req.requestId
      });
    }
    req.propertyId = property;
  } else {
    req.propertyId = null;
  }
  next();
}

module.exports = tenantContext;
