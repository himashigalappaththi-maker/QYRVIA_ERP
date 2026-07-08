'use strict';

/**
 * TripAdvisorAdapter (STUB). Satisfies the OTAAdapter contract surface so the
 * registry + tests treat it as a real channel. Network operations throw until
 * real TripAdvisor API credentials and certification are obtained.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS } = require('../../core/canonical/types');

class TripAdvisorAdapter extends OTAAdapter {
  constructor() { super(CHANNELS.TRIPADVISOR); }
  async pushRates()      { throw new Error('not_implemented: TRIPADVISOR pushRates (stub)'); }
  async pushInventory()  { throw new Error('not_implemented: TRIPADVISOR pushInventory (stub)'); }
  async pullBookings()   { throw new Error('not_implemented: TRIPADVISOR pullBookings (stub)'); }
  async confirmBooking() { throw new Error('not_implemented: TRIPADVISOR confirmBooking (stub)'); }
  async cancelBooking()  { throw new Error('not_implemented: TRIPADVISOR cancelBooking (stub)'); }
  mapToCanonical(raw) {
    return makeCanonicalBooking({ bookingId: raw.id, channel: CHANNELS.TRIPADVISOR,
      guestName: raw.guestName, raw });
  }
}

module.exports = { TripAdvisorAdapter };
