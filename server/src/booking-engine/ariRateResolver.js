'use strict';

/**
 * D1 — ARI rate resolver (Phase 52).
 *
 * Factory: buildAriRateResolver({ ariService })
 * Returns: async function rateResolver(input) -> number (per-night rate)
 *
 * Calls ariService.quoteStay() and returns total / los (los = length-of-stay nights).
 * If quoteStay returns bookable:false or throws, returns 0 (the engine will reject
 * the booking at the pricing/validation step).
 *
 * IMPORTANT: Must NOT require from ari/ — ariService is injected as an opaque object.
 *
 * input shape (from bookingService.js):
 *   { room_type_id, rate_plan_id, arrival, departure, adults, property_id, tenant_id, channel }
 *
 * Maps to quoteStay params:
 *   { tenantId, propertyId, roomTypeId, ratePlanId, arrival, departure, adults, channel }
 */

function buildAriRateResolver({ ariService } = {}) {
  if (!ariService || typeof ariService.quoteStay !== 'function') {
    throw new Error('buildAriRateResolver: ariService with quoteStay() required');
  }

  return async function ariRateResolver(input) {
    try {
      const result = await ariService.quoteStay({
        tenantId:   input.tenantId   || input.tenant_id   || null,
        propertyId: input.propertyId || input.property_id || null,
        roomTypeId: input.roomTypeId || input.room_type_id || null,
        ratePlanId: input.ratePlanId || input.rate_plan_id || null,
        arrival:    input.arrival,
        departure:  input.departure,
        adults:     input.adults,
        channel:    input.channel || null
      });

      if (!result || !result.bookable) return 0;

      const los = result.los;
      if (!los || los === 0) return 0;

      // Return per-night rate: total / nights
      return result.total / los;
    } catch (_) {
      return 0;
    }
  };
}

module.exports = { buildAriRateResolver };
