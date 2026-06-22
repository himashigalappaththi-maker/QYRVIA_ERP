'use strict';

/**
 * AirbnbAdapter (STUB). See AgodaAdapter for the stub rationale.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS } = require('../../core/canonical/types');

class AirbnbAdapter extends OTAAdapter {
  constructor() { super(CHANNELS.AIRBNB); }
  async pushRates()     { throw new Error('not_implemented: AIRBNB pushRates (stub)'); }
  async pushInventory() { throw new Error('not_implemented: AIRBNB pushInventory (stub)'); }
  async pullBookings()  { throw new Error('not_implemented: AIRBNB pullBookings (stub)'); }
  async confirmBooking(){ throw new Error('not_implemented: AIRBNB confirmBooking (stub)'); }
  async cancelBooking() { throw new Error('not_implemented: AIRBNB cancelBooking (stub)'); }
  mapToCanonical(raw) {
    return makeCanonicalBooking({ bookingId: raw.id, channel: CHANNELS.AIRBNB,
      guestName: raw.guestName, raw });
  }
}

module.exports = { AirbnbAdapter };
