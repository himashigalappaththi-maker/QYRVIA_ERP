'use strict';

/**
 * QTCNAdapter (Channel Manager / Phase 10.0 contract).
 *
 * QTCN is a STANDARD OTA adapter - it behaves exactly like BookingComAdapter
 * and has NO privileged logic, NO `internal` flag, NO routing/scoring/decision
 * making, and NO architectural priority. Its only distinguishing attribute is
 * its commercial model: commission = 15%.
 *
 * It implements the same six-method Channel Manager adapter contract as every
 * other adapter and flows through the same sync engine + event bus.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS, BOOKING_STATUS } = require('../../core/canonical/types');
const logger = require('../../../config/logger');

const QTCN_COMMISSION_PCT = 15;

class QTCNAdapter extends OTAAdapter {
  constructor({ source = [] } = {}) {
    super(CHANNELS.QYRVIA_CONNECT);
    this.commissionPct = QTCN_COMMISSION_PCT;   // commercial model only; not a privilege
    this._source = source;
  }

  async pushRates(rate) {
    logger.debug({ rate }, '[QTCN] pushRates');
  }

  async pushInventory(inv) {
    logger.debug({ inv }, '[QTCN] pushInventory');
  }

  async pullBookings() {
    return this._source.slice();
  }

  async confirmBooking(id) {
    logger.debug({ id }, '[QTCN] confirmBooking');
  }

  async cancelBooking(id) {
    logger.debug({ id }, '[QTCN] cancelBooking');
  }

  mapToCanonical(raw) {
    return makeCanonicalBooking({
      bookingId: raw.id,
      channel: CHANNELS.QYRVIA_CONNECT,
      status: raw.status && BOOKING_STATUS[raw.status] ? raw.status : BOOKING_STATUS.PENDING,
      guestName: raw.guestName,
      arrival: raw.checkin || raw.arrival || null,
      departure: raw.checkout || raw.departure || null,
      amount: raw.amount != null ? raw.amount : null,
      currency: raw.currency || null,
      roomTypeId: raw.roomType || raw.roomTypeId || null,
      commissionPct: QTCN_COMMISSION_PCT,
      externalRef: raw.id,
      raw
    });
  }
}

module.exports = { QTCNAdapter };
