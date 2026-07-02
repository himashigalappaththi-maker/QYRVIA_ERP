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
