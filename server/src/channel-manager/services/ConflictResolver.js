'use strict';

/**
 * ConflictResolver - decides the winner when two bookings compete for the same
 * physical slot (property + room type + stay dates) across channels.
 *
 * Policy (deterministic, documented). No OTA has priority over another - all
 * channels are equal; there is no QYRVIA_CONNECT (or any channel) favoritism here:
 *   1. Same bookingId  -> not a conflict (idempotent update).
 *   2. CONFIRMED beats PENDING.
 *   3. Tie-break        -> incumbent (first-come) is retained.
 */

const { BOOKING_STATUS } = require('../core/canonical/types');

function slotKey(b) {
  return [b.propertyId, b.roomTypeId, b.arrival, b.departure].join('|');
}

function resolve(existing, incoming) {
  if (!existing) return { conflict: false, winner: incoming, reason: 'no_incumbent' };
  if (existing.bookingId === incoming.bookingId) {
    return { conflict: false, winner: incoming, loser: null, reason: 'same_booking_update' };
  }

  // 2. CONFIRMED beats PENDING (status-based, channel-agnostic).
  const exC = existing.status === BOOKING_STATUS.CONFIRMED;
  const inC = incoming.status === BOOKING_STATUS.CONFIRMED;
  if (exC !== inC) {
    const winner = exC ? existing : incoming;
    const loser  = exC ? incoming : existing;
    return { conflict: true, winner, loser, reason: 'confirmed_beats_pending' };
  }

  // 3. Tie-break: keep incumbent (first-come). No channel favoritism.
  return { conflict: true, winner: existing, loser: incoming, reason: 'incumbent_retained' };
}

module.exports = { resolve, slotKey };
