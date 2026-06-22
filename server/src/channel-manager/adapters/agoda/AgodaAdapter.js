'use strict';

/**
 * AgodaAdapter (STUB). Satisfies the contract surface so the registry + tests
 * treat it as a real channel; network operations throw until implemented.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS } = require('../../core/canonical/types');

class AgodaAdapter extends OTAAdapter {
  constructor() { super(CHANNELS.AGODA); }
  async pushRates()     { throw new Error('not_implemented: AGODA pushRates (stub)'); }
  async pushInventory() { throw new Error('not_implemented: AGODA pushInventory (stub)'); }
  async pullBookings()  { throw new Error('not_implemented: AGODA pullBookings (stub)'); }
  async confirmBooking(){ throw new Error('not_implemented: AGODA confirmBooking (stub)'); }
  async cancelBooking() { throw new Error('not_implemented: AGODA cancelBooking (stub)'); }
  mapToCanonical(raw) {
    return makeCanonicalBooking({ bookingId: raw.id, channel: CHANNELS.AGODA,
      guestName: raw.guestName, raw });
  }
}

module.exports = { AgodaAdapter };
