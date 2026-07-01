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

function buildBookingEngine({ commandBus, bookingStore, availabilityProvider, roomTypeExists, rateResolver, onEvent } = {}) {
  const pricingEngine = buildPricingEngine({});
  const availabilityEngine = buildAvailabilityEngine({ availabilityProvider });
  const validator = buildBookingValidator({ roomTypeExists });
  const service = buildBookingService({ commandBus, bookingStore, availabilityEngine, pricingEngine, validator, rateResolver, onEvent });
  return { service, pricingEngine, availabilityEngine, validator };
}

module.exports = { buildBookingEngine, buildBookingService, buildPricingEngine, buildAvailabilityEngine, buildBookingValidator };
