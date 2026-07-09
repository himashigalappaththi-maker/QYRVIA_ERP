'use strict';

/**
 * D2 — ARI availability provider (Phase 52).
 *
 * Factory: buildAriAvailabilityProvider({ ariService })
 * Returns: async function provider(ctx, { room_type_id, rate_plan_id, arrival, departure }) -> number
 *
 * Contract:
 *   - Must return a finite integer >= 0.
 *   - Never throws for "no availability" — returns 0.
 *   - Throws { reason: 'property_context_required' } only when ctx.propertyId or
 *     ctx.tenantId is absent (matches pmsAvailabilityProvider.js contract exactly).
 *
 * Calls ariService.quoteStay() and returns quote.available (the limiting night count).
 *
 * IMPORTANT: Must NOT require from ari/ — ariService is injected as an opaque object.
 */

function buildAriAvailabilityProvider({ ariService } = {}) {
  if (!ariService || typeof ariService.quoteStay !== 'function') {
    throw new Error('buildAriAvailabilityProvider: ariService with quoteStay() required');
  }

  return async function ariAvailabilityProvider(ctx, input = {}) {
    const { room_type_id, rate_plan_id, arrival, departure } = input;

    // Property context is mandatory — fail-closed per pmsAvailabilityProvider.js pattern.
    if (!ctx || !ctx.tenantId || !ctx.propertyId) {
      throw Object.assign(
        new Error('property context required for ARI availability check'),
        { reason: 'property_context_required' }
      );
    }

    // Without a rate_plan_id we cannot call quoteStay — return 0 (fail closed).
    // The booking engine should pass rate_plan_id through input when using ARI.
    if (!rate_plan_id) return 0;

    try {
      const result = await ariService.quoteStay({
        tenantId:   ctx.tenantId,
        propertyId: ctx.propertyId,
        roomTypeId: room_type_id || null,
        ratePlanId: rate_plan_id || null,
        arrival,
        departure,
        channel:    ctx.channel || null
      });

      if (!result) return 0;

      // available is the limiting room count across the stay (from stayAvailability)
      const avail = Number(result.available);
      if (!Number.isFinite(avail)) return 0;
      return Math.max(0, Math.floor(avail));
    } catch (err) {
      // Re-throw context errors; swallow all others (fail to 0, not exception)
      if (err && err.reason === 'property_context_required') throw err;
      return 0;
    }
  };
}

module.exports = { buildAriAvailabilityProvider };
