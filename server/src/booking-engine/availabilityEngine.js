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

/**
 * How many rooms this request needs. Anything absent, non-numeric, zero or
 * negative means one room — never zero, which would make every request
 * trivially satisfiable.
 */
function requestedRooms(input) {
  const raw = (input && (input.rooms_count != null ? input.rooms_count : input.rooms));
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

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

      // Phase 63 P0-5: honour the number of ROOMS requested.
      // The rule used to be `n > 0` unconditionally, so a 3-room request was
      // accepted against a single available room and then booked as 1 room
      // (mapInput also dropped rooms_count). Compare against demand.
      const requested = requestedRooms(input);
      if (n > 0 && n < requested) {
        return { available: false, rooms: n, requested, reason: 'insufficient_rooms_available' };
      }
      return { available: n >= requested, rooms: n, requested };
    }
  };
}

module.exports = { buildAvailabilityEngine, requestedRooms };
