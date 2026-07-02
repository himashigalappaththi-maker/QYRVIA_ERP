'use strict';

/**
 * buildPmsAvailabilityProvider (Phase 37 WI-1) - a fail-closed availabilityProvider
 * for the Booking Engine, backed by the REAL PMS availability service
 * (services/pms/availability.roomsByDate). It reads live inventory only; it never
 * invents rooms.
 *
 * A booking spans a range, so this checks every night in [arrival, departure) and
 * returns the MINIMUM rooms available for the room type across the stay (the
 * binding constraint). Read-only - it does not reserve or mutate anything; atomic
 * oversell protection remains the PMS/DB write layer's responsibility.
 *
 * Property context is mandatory: tenant isolation is RLS-enforced, but property
 * scoping is application-level. If ctx.propertyId (or tenantId) is missing this
 * THROWS { reason:'property_context_required' } so the engine fails closed rather
 * than guessing inventory.
 *
 *   availabilityProvider(ctx, { room_type_id, arrival, departure }) -> number
 */

const availability = require('../services/pms/availability');

function eachNight(arrival, departure) {
  const out = [];
  const start = Date.parse(String(arrival) + 'T00:00:00Z');
  const end = Date.parse(String(departure) + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return out;
  for (let t = start; t < end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function buildPmsAvailabilityProvider({ pmsRepo } = {}) {
  if (!pmsRepo) throw new Error('buildPmsAvailabilityProvider: pmsRepo required');

  return async function availabilityProvider(ctx, { room_type_id, arrival, departure } = {}) {
    if (!ctx || !ctx.tenantId || !ctx.propertyId) {
      throw Object.assign(new Error('property context required for availability check'), { reason: 'property_context_required' });
    }
    const nights = eachNight(arrival, departure);
    if (!room_type_id || nights.length === 0) {
      throw Object.assign(new Error('room_type_id and a valid stay range are required'), { reason: 'availability_unknown' });
    }

    let min = Infinity;
    for (const date of nights) {
      const byType = await availability.roomsByDate(pmsRepo, {
        tenantId: ctx.tenantId, propertyId: ctx.propertyId, date, roomTypeId: room_type_id
      });
      const slot = byType && byType[room_type_id];
      // Room type absent that night => 0 available (honest: never invent inventory).
      const avail = slot && Number.isFinite(Number(slot.available)) ? Number(slot.available) : 0;
      if (avail < min) min = avail;
    }
    return Number.isFinite(min) ? min : 0;
  };
}

module.exports = { buildPmsAvailabilityProvider };
