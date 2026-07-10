'use strict';

/**
 * bookingValidator (Booking Engine v1) - enforces: date validity, room_type
 * existence, the PMS-aligned adult rule (>= 1 adult), availability, and pricing
 * success. Reject path: { ok:false, reason:'VALIDATION_FAILED', detail:[...] }.
 */

function validDate(d) { return !!d && !isNaN(new Date(d).getTime()); }

function buildBookingValidator({ roomTypeExists } = {}) {
  return {
    validate(input, { availability, pricing } = {}) {
      if (!input) return { ok: false, reason: 'VALIDATION_FAILED', detail: ['no_input'] };
      const reasons = [];
      if (!validDate(input.arrival) || !validDate(input.departure) || new Date(input.arrival) >= new Date(input.departure)) reasons.push('invalid_dates');
      if (!input.room_type_id) reasons.push('room_type_required');
      else if (typeof roomTypeExists === 'function' && !roomTypeExists(input.room_type_id)) reasons.push('room_type_not_found');
      if (!(Number(input.adults) >= 1)) reasons.push('adult_required');
      // D0: direct/web bookings require holder_guest_id (FK into guests table).
      // OTA channels are permissive — they supply external_ref but may not yet
      // have a resolved guest UUID at ingest time.
      const ch = (input.channel || 'DIRECT').toUpperCase();
      if (!ch || ch === 'DIRECT' || ch === 'WEB') {
        if (!input.holder_guest_id || typeof input.holder_guest_id !== 'string' || !input.holder_guest_id.trim()) {
          reasons.push({ field: 'holder_guest_id', reason: 'required_for_direct_booking' });
        }
      }
      // String length caps (Phase 54 D7a)
      if (input.guest_name   && input.guest_name.length   > 200)  reasons.push({ field: 'guest_name',   reason: 'max_length_200' });
      if (input.notes        && input.notes.length         > 2000) reasons.push({ field: 'notes',        reason: 'max_length_2000' });
      if (input.external_ref && input.external_ref.length  > 512)  reasons.push({ field: 'external_ref', reason: 'max_length_512' });
      // Numeric range caps (Phase 54 D7a)
      if (typeof input.adults   === 'number' && input.adults   > 50) reasons.push({ field: 'adults',   reason: 'max_50' });
      if (typeof input.children === 'number' && input.children > 50) reasons.push({ field: 'children', reason: 'max_50' });
      // Fail-closed availability (Phase 37 WI-1): surface the specific reason the
      // guard reported (availability_provider_unwired / availability_unknown /
      // property_context_required), falling back to the generic 'unavailable' for a
      // genuine zero-inventory result. Additive detail only; envelope shape unchanged.
      if (availability && availability.available === false) reasons.push(availability.reason || 'unavailable');
      if (pricing && pricing.ok === false) reasons.push('pricing_failed');
      return reasons.length ? { ok: false, reason: 'VALIDATION_FAILED', detail: reasons } : { ok: true };
    }
  };
}

module.exports = { buildBookingValidator };
