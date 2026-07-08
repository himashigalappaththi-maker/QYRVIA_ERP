'use strict';

/**
 * MakeMyTripAdapter (STUB). Satisfies the OTAAdapter contract surface so the
 * registry + tests treat it as a real channel. Network operations throw until
 * real API credentials and certification are obtained.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS } = require('../../core/canonical/types');

class MakeMyTripAdapter extends OTAAdapter {
  constructor() { super(CHANNELS.MAKEMYTRIP); }
  async pushRates()      { throw new Error('not_implemented: MAKEMYTRIP pushRates (stub)'); }
  async pushInventory()  { throw new Error('not_implemented: MAKEMYTRIP pushInventory (stub)'); }
  async pullBookings()   { throw new Error('not_implemented: MAKEMYTRIP pullBookings (stub)'); }
  async confirmBooking() { throw new Error('not_implemented: MAKEMYTRIP confirmBooking (stub)'); }
  async cancelBooking()  { throw new Error('not_implemented: MAKEMYTRIP cancelBooking (stub)'); }
  mapToCanonical(raw) {
    return makeCanonicalBooking({ bookingId: raw.id, channel: CHANNELS.MAKEMYTRIP,
      guestName: raw.guestName, raw });
  }
}

module.exports = { MakeMyTripAdapter };
