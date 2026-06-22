'use strict';

/** Booking.com OTA adapter (Phase 10.2). One OTA = one file. */
const { OTAAdapter } = require('../base/assertAdapter');

class BookingComAdapter extends OTAAdapter {
  constructor() { super('booking.com', { commissionPct: 15 }); }
}

module.exports = { channel: 'booking.com', Adapter: BookingComAdapter };
