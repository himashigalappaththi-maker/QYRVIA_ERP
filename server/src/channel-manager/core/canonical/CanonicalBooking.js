'use strict';

/**
 * CanonicalBooking - the normalized booking shape every adapter must produce.
 *
 *   makeCanonicalBooking(fields) -> frozen, validated canonical booking
 *
 * Required: bookingId, channel, status. Everything else is optional but
 * normalized (dates as 'YYYY-MM-DD', amounts as numbers).
 */

const { isChannel, isBookingStatus, BOOKING_STATUS } = require('./types');

function makeCanonicalBooking(fields = {}) {
  const f = fields || {};
  if (!f.bookingId) throw new Error('CanonicalBooking: bookingId required');
  if (!isChannel(f.channel)) throw new Error('CanonicalBooking: invalid channel ' + JSON.stringify(f.channel));
  const status = f.status || BOOKING_STATUS.PENDING;
  if (!isBookingStatus(status)) throw new Error('CanonicalBooking: invalid status ' + JSON.stringify(status));

  return Object.freeze({
    bookingId:    String(f.bookingId),
    channel:      f.channel,
    status,
    guestName:    f.guestName || null,
    propertyId:   f.propertyId || null,
    roomTypeId:   f.roomTypeId || null,
    arrival:      f.arrival || null,       // 'YYYY-MM-DD'
    departure:    f.departure || null,     // 'YYYY-MM-DD'
    amount:       f.amount != null ? Number(f.amount) : null,
    currency:     f.currency || null,
    // Channel-side commission. QYRVIA_CONNECT is zero-commission (QYRVIA-owned).
    commissionPct: f.commissionPct != null ? Number(f.commissionPct) : null,
    externalRef:  f.externalRef || String(f.bookingId),
    raw:          f.raw || null            // opaque vendor payload, for audit only
  });
}

/** Stable idempotency key for a booking event from a given channel. */
function bookingKey(channel, bookingId) {
  return 'booking:' + channel + ':' + bookingId;
}

module.exports = { makeCanonicalBooking, bookingKey };
