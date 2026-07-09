'use strict';

/**
 * D4 — ARI inventory adjuster (Phase 52).
 *
 * Factory: buildAriInventoryAdjuster({ ariStore })
 * Returns object: { async adjustSold({ tenantId, propertyId, roomTypeId, arrival, departure, delta }) }
 *
 * Loops over each night in [arrival, departure) and calls ariStore.adjustSold() per night.
 * If ariStore.adjustSold() returns null for a night (sold floor guard — sold already at 0
 * and a decrement would go negative), logs a warning but continues processing remaining nights.
 *
 * IMPORTANT: Must NOT require from ari/ — ariStore is injected as an opaque object.
 *
 * Night iteration: from arrival (inclusive) to departure (exclusive), ISO YYYY-MM-DD per night.
 */

const logger = require('../config/logger');

function nightDates(arrival, departure) {
  const out = [];
  const start = Date.parse(String(arrival) + 'T00:00:00Z');
  const end   = Date.parse(String(departure) + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return out;
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t);
    out.push(
      d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0')
    );
  }
  return out;
}

function buildAriInventoryAdjuster({ ariStore } = {}) {
  if (!ariStore || typeof ariStore.adjustSold !== 'function') {
    throw new Error('buildAriInventoryAdjuster: ariStore with adjustSold() required');
  }

  return {
    async adjustSold({ tenantId, propertyId, roomTypeId, arrival, departure, delta }) {
      const dates = nightDates(arrival, departure);
      for (const date of dates) {
        try {
          const result = await ariStore.adjustSold({ tenant_id: tenantId, propertyId, roomTypeId, date, delta });
          if (result === null) {
            // sold floor guard: sold already at 0, double-decrement prevented
            logger.warn({ tenantId, propertyId, roomTypeId, date, delta }, '[ariInventoryAdjuster] adjustSold returned null (floor guard) — continuing');
          }
        } catch (err) {
          logger.error({ err, tenantId, propertyId, roomTypeId, date, delta }, '[ariInventoryAdjuster] adjustSold error for night');
          // Continue to remaining nights — partial success is better than none
        }
      }
    }
  };
}

module.exports = { buildAriInventoryAdjuster };
