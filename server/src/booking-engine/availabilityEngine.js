'use strict';

/**
 * availabilityEngine (Booking Engine v1) - READ-ONLY overbooking guard. Reads an
 * injected inventory snapshot provider; never mutates anything. PMS remains the
 * source of truth. Rule: available_rooms <= 0 => not available (reject).
 *
 * availabilityProvider(ctx, { room_type_id, arrival, departure }) -> number
 * (rooms available).
 *
 * FAIL-CLOSED (Phase 37 WI-1): the guard refuses rather than assumes availability
 * whenever it cannot obtain a real, finite room count:
 *   - no provider wired            -> { available:false, reason:'availability_provider_unwired' }
 *   - provider throws              -> { available:false, reason: err.reason || 'availability_unknown' }
 *   - provider returns non-finite  -> { available:false, reason:'availability_unknown' }
 *                                     (Infinity / NaN / undefined are NOT "available")
 * A real finite count decides normally: available = rooms > 0. A genuine 0 from a
 * real provider carries no reason -> the validator reports the existing 'unavailable'.
 */

function buildAvailabilityEngine({ availabilityProvider } = {}) {
  const hasProvider = typeof availabilityProvider === 'function';
  return {
    // Phase 52: pass through the full input object so ARI providers can use
    // rate_plan_id (and others) without breaking the existing pmsAvailabilityProvider
    // contract (it destructures only room_type_id, arrival, departure and ignores extra).
    async check(ctx, input = {}) {
      if (!hasProvider) return { available: false, rooms: 0, reason: 'availability_provider_unwired' };
      let n;
      try {
        n = Number(await Promise.resolve(availabilityProvider(ctx, input)));
      } catch (err) {
        return { available: false, rooms: null, reason: (err && err.reason) || 'availability_unknown' };
      }
      if (!Number.isFinite(n)) return { available: false, rooms: null, reason: 'availability_unknown' };
      return { available: n > 0, rooms: n };
    }
  };
}

module.exports = { buildAvailabilityEngine };
