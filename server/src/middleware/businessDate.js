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
        // Phase 64 P0-11: pass the tenant. `properties` is FORCE-RLS, so this
        // lookup must be tenant-bound — and the tenant is also the predicate the
        // query itself was missing.
        const row = await repo.findPropertyBusinessDate(req.ctx.propertyId, req.ctx.tenantId);
        // Phase 63 P0-9 — distinguish "no row" from "row with no date".
        //
        // Both used to fall into the same else-branch, which defaulted the
        // business date to today AND businessDateLocked to false. A NULL row
        // does not mean "new property": it also means the property was not
        // visible (RLS blocked the read, wrong tenant, deleted property). In
        // that case the request proceeded believing accounting was UNLOCKED
        // and stamped folio lines with a fabricated business date — silently
        // defeating the night-audit financial lock.
        //
        // A row with a null current_business_date is the genuine brand-new
        // property case and still defaults to today, but it carries the real
        // lock flag rather than assuming false.
        if (!row) {
          logger.error({
            request_id: req.requestId,
            property_id: req.ctx.propertyId,
            code: 'property_business_date_unresolved'
          }, '[businessDate] property row not visible — refusing to assume an unlocked business date');
          return res.status(409).json({
            error: 'property_business_date_unresolved',
            requestId: req.requestId
          });
        }
        dateLocked = !!row.business_date_locked;
        if (row.current_business_date) {
          businessDate = String(row.current_business_date).slice(0, 10);
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
