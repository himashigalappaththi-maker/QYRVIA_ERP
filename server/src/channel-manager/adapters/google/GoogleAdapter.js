'use strict';

/**
 * GoogleAdapter (STUB). Google Hotel Ads integration. Satisfies the OTAAdapter
 * contract surface so the registry + tests treat it as a real channel. Network
 * operations throw until real Google Hotel Ads API access is configured.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS } = require('../../core/canonical/types');

class GoogleAdapter extends OTAAdapter {
  constructor() { super(CHANNELS.GOOGLE); }
  async pushRates()      { throw new Error('not_implemented: GOOGLE pushRates (stub)'); }
  async pushInventory()  { throw new Error('not_implemented: GOOGLE pushInventory (stub)'); }
  async pullBookings()   { throw new Error('not_implemented: GOOGLE pullBookings (stub)'); }
  async confirmBooking() { throw new Error('not_implemented: GOOGLE confirmBooking (stub)'); }
  async cancelBooking()  { throw new Error('not_implemented: GOOGLE cancelBooking (stub)'); }
  mapToCanonical(raw) {
    return makeCanonicalBooking({ bookingId: raw.id, channel: CHANNELS.GOOGLE,
      guestName: raw.guestName, raw });
  }
}

module.exports = { GoogleAdapter };
