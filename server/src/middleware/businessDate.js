'use strict';

const logger = require('../config/logger');

/**
 * Business-date middleware (adjustment #1).
 *
 * Looks up `properties.current_business_date` for `req.ctx.propertyId` once
 * per request and attaches it to req.ctx.businessDate. If the property has
 * no business date set yet (brand-new property, never Night-Audited),
 * defaults to today (calendar) and logs at INFO level.
 *
 * If `req.ctx.propertyId` is null (tenant-only operation, e.g. admin user
 * management), businessDate stays null.
 *
 * Build with a `repo` that exposes:
 *   findPropertyBusinessDate(propertyId) =>
 *     { current_business_date, business_date_locked } | null
 */
function businessDateMiddleware(repo) {
  return async function (req, res, next) {
    try {
      if (!req.ctx) {
        return res.status(500).json({ error: 'identity_context_missing', requestId: req.requestId });
      }
      let businessDate = null;
      let dateLocked   = false;
      if (req.ctx.propertyId && repo && typeof repo.findPropertyBusinessDate === 'function') {
        const row = await repo.findPropertyBusinessDate(req.ctx.propertyId);
        if (row && row.current_business_date) {
          businessDate = String(row.current_business_date).slice(0, 10);
          dateLocked   = !!row.business_date_locked;
        } else {
          businessDate = new Date().toISOString().slice(0, 10);
          logger.info({
            request_id: req.requestId,
            property_id: req.ctx.propertyId
          }, '[businessDate] property has no current_business_date; defaulted to today');
        }
      }
      // re-freeze req.ctx with businessDate populated
      req.ctx = Object.freeze(Object.assign({}, req.ctx, {
        businessDate: businessDate,
        businessDateLocked: dateLocked
      }));
      next();
    } catch (err) {
      logger.error({ err, request_id: req.requestId }, '[businessDate] lookup failed');
      res.status(500).json({ error: 'business_date_lookup_failed', requestId: req.requestId });
    }
  };
}

module.exports = { businessDateMiddleware };
