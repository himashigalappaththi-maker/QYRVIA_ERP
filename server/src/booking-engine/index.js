'use strict';

/**
 * Booking Engine v1 factory (DI entry point). Pure orchestration on top of PMS
 * (via commandBus) + the existing booking_store idempotency. No PMS/OTA/worker/
 * queue/webhook/UI changes.
 */

const { buildBookingService } = require('./bookingService');
const { buildPricingEngine } = require('./pricingEngine');
const { buildAvailabilityEngine } = require('./availabilityEngine');
const { buildBookingValidator } = require('./bookingValidator');
const { buildPmsAvailabilityProvider } = require('./pmsAvailabilityProvider');

// Phase 37 WI-1: the availability guard is FAIL-CLOSED. If neither an explicit
// availabilityProvider nor a pmsRepo is supplied, no provider is wired and the
// engine refuses bookings (rather than assuming availability). Pass `pmsRepo` to
// back the guard with real PMS inventory (services/pms/availability).
// Phase 52: ariService / ariStore / inventoryAdjuster are optional DI slots; all
// are no-op / absent by default so existing behavior is unchanged.
function buildBookingEngine({ commandBus, bookingStore, availabilityProvider, pmsRepo, roomTypeExists, rateResolver, inventoryAdjuster, ariService, ariStore, onEvent } = {}) {
  const provider = availabilityProvider || (pmsRepo ? buildPmsAvailabilityProvider({ pmsRepo }) : undefined);
  const pricingEngine = buildPricingEngine({});
  const availabilityEngine = buildAvailabilityEngine({ availabilityProvider: provider });
  const validator = buildBookingValidator({ roomTypeExists });
  const service = buildBookingService({ commandBus, bookingStore, availabilityEngine, pricingEngine, validator, rateResolver, inventoryAdjuster, onEvent });
  return { service, pricingEngine, availabilityEngine, validator };
}

module.exports = { buildBookingEngine, buildBookingService, buildPricingEngine, buildAvailabilityEngine, buildBookingValidator, buildPmsAvailabilityProvider };
