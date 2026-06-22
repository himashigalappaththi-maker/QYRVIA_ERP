'use strict';

/**
 * BookingComAdapter - first working (mock) OTA adapter.
 *
 * Implements the full OTAAdapter contract against mock data. Network calls are
 * stubbed (logged) so the whole sync path is exercisable end-to-end without
 * Booking.com credentials. Swapping in the real REST/XML client later touches
 * ONLY this file - the canonical model and core stay unchanged.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS, BOOKING_STATUS } = require('../../core/canonical/types');
const { MOCK_BOOKINGS } = require('./bookingcom.mock');
const logger = require('../../../config/logger');

class BookingComAdapter extends OTAAdapter {
  constructor({ source = MOCK_BOOKINGS } = {}) {
    super(CHANNELS.BOOKING_COM);
    this._source = source;
  }

  async pushRates(rate) {
    logger.debug({ rate }, '[Booking.com MOCK] pushRates');
  }

  async pushInventory(inv) {
    logger.debug({ inv }, '[Booking.com MOCK] pushInventory');
  }

  async pullBookings() {
    // Returns RAW vendor payloads; mapping to canonical is a separate step.
    return this._source.slice();
  }

  async confirmBooking(id) {
    logger.debug({ id }, '[Booking.com MOCK] confirmBooking');
  }

  async cancelBooking(id) {
    logger.debug({ id }, '[Booking.com MOCK] cancelBooking');
  }

  mapToCanonical(raw) {
    return makeCanonicalBooking({
      bookingId: raw.id,
      channel: CHANNELS.BOOKING_COM,
      status: raw.status && BOOKING_STATUS[raw.status] ? raw.status : BOOKING_STATUS.PENDING,
      guestName: raw.guestName,
      arrival: raw.checkin || null,
      departure: raw.checkout || null,
      amount: raw.amount != null ? raw.amount : null,
      currency: raw.currency || null,
      roomTypeId: raw.roomType || null,
      externalRef: raw.id,
      raw
    });
  }
}

module.exports = { BookingComAdapter };
