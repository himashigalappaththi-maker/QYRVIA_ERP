'use strict';

/**
 * ExpediaAdapter (STUB). See AgodaAdapter for the stub rationale.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS } = require('../../core/canonical/types');

class ExpediaAdapter extends OTAAdapter {
  constructor() { super(CHANNELS.EXPEDIA); }
  async pushRates()     { throw new Error('not_implemented: EXPEDIA pushRates (stub)'); }
  async pushInventory() { throw new Error('not_implemented: EXPEDIA pushInventory (stub)'); }
  async pullBookings()  { throw new Error('not_implemented: EXPEDIA pullBookings (stub)'); }
  async confirmBooking(){ throw new Error('not_implemented: EXPEDIA confirmBooking (stub)'); }
  async cancelBooking() { throw new Error('not_implemented: EXPEDIA cancelBooking (stub)'); }
  mapToCanonical(raw) {
    return makeCanonicalBooking({ bookingId: raw.id, channel: CHANNELS.EXPEDIA,
      guestName: raw.guestName, raw });
  }
}

module.exports = { ExpediaAdapter };
