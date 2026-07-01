'use strict';

/**
 * availabilityEngine (Booking Engine v1) - READ-ONLY overbooking guard. Reads an
 * injected inventory snapshot provider; never mutates anything. PMS remains the
 * source of truth. Rule: available_rooms <= 0 => not available (reject).
 *
 * availabilityProvider(ctx, { room_type_id, arrival, departure }) -> number
 * (rooms available). Default: unbounded (no block) so the engine is inert until a
 * real provider is wired.
 */

function buildAvailabilityEngine({ availabilityProvider } = {}) {
  const provider = typeof availabilityProvider === 'function' ? availabilityProvider : () => Infinity;
  return {
    async check(ctx, { room_type_id, arrival, departure } = {}) {
      const rooms = await Promise.resolve(provider(ctx, { room_type_id, arrival, departure }));
      const n = Number(rooms);
      const available = Number.isFinite(n) ? n > 0 : true;
      return { available, rooms: Number.isFinite(n) ? n : null };
    }
  };
}

module.exports = { buildAvailabilityEngine };
