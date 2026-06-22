'use strict';

/**
 * QTCNAdapter - QYRVIA Travel Commerce Network.
 *
 * QTCN is QYRVIA's OWN distribution channel. It implements the same
 * OTAAdapter contract so the core treats it uniformly, but it is a
 * FIRST-CLASS INTERNAL channel, which means:
 *
 *   - Zero commission (commissionPct = 0) - direct revenue, no OTA cut.
 *   - Fastest sync path: pushes are in-process (no external HTTP/XML, no
 *     vendor rate limits, no network latency) so they resolve immediately.
 *   - Real-time inventory: because there is no remote system to reconcile,
 *     a push is authoritative the moment it returns.
 *
 * Bookings originate inside QYRVIA (direct web/app/front-desk), so
 * `pullBookings` reads an internal source rather than a remote API.
 */

const { OTAAdapter } = require('../base/OTAAdapter');
const { makeCanonicalBooking } = require('../../core/canonical/CanonicalBooking');
const { CHANNELS, BOOKING_STATUS } = require('../../core/canonical/types');

class QTCNAdapter extends OTAAdapter {
  constructor({ internalSource = [] } = {}) {
    super(CHANNELS.QTCN);
    this.internal = true;
    this.commissionPct = 0;          // zero-commission by definition
    this._internalSource = internalSource;
  }

  // In-process, authoritative, no network. Resolves immediately.
  async pushRates(/* rate */) { /* applied in-process; nothing to call out to */ }
  async pushInventory(/* inv */) { /* real-time, authoritative on return */ }

  async pullBookings() {
    return this._internalSource.slice();
  }

  async confirmBooking(/* id */) { /* internal booking already authoritative */ }
  async cancelBooking(/* id */) { /* internal cancel is immediate */ }

  mapToCanonical(raw) {
    return makeCanonicalBooking({
      bookingId: raw.id,
      channel: CHANNELS.QTCN,
      status: raw.status && BOOKING_STATUS[raw.status] ? raw.status : BOOKING_STATUS.CONFIRMED,
      guestName: raw.guestName,
      propertyId: raw.propertyId || null,
      roomTypeId: raw.roomTypeId || null,
      arrival: raw.arrival || null,
      departure: raw.departure || null,
      amount: raw.amount != null ? raw.amount : null,
      currency: raw.currency || null,
      commissionPct: 0,
      externalRef: raw.id,
      raw
    });
  }
}

module.exports = { QTCNAdapter };
