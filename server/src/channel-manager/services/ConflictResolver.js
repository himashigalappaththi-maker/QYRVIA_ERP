'use strict';

/**
 * ConflictResolver - decides the winner when two bookings compete for the same
 * physical slot (property + room type + stay dates) across channels.
 *
 * Policy (deterministic, documented):
 *   1. Same bookingId  -> not a conflict (idempotent update).
 *   2. QTCN wins        -> protect direct, zero-commission revenue over OTAs.
 *   3. CONFIRMED beats PENDING.
 *   4. Tie-break        -> incumbent (first-come) is retained.
 */

const { CHANNELS, BOOKING_STATUS } = require('../core/canonical/types');

function slotKey(b) {
  return [b.propertyId, b.roomTypeId, b.arrival, b.departure].join('|');
}

function resolve(existing, incoming) {
  if (!existing) return { conflict: false, winner: incoming, reason: 'no_incumbent' };
  if (existing.bookingId === incoming.bookingId) {
    return { conflict: false, winner: incoming, loser: null, reason: 'same_booking_update' };
  }

  // 2. QTCN priority
  const exQ = existing.channel === CHANNELS.QTCN;
  const inQ = incoming.channel === CHANNELS.QTCN;
  if (exQ !== inQ) {
    const winner = exQ ? existing : incoming;
    const loser  = exQ ? incoming : existing;
    return { conflict: true, winner, loser, reason: 'qtcn_priority' };
  }

  // 3. CONFIRMED beats PENDING
  const exC = existing.status === BOOKING_STATUS.CONFIRMED;
  const inC = incoming.status === BOOKING_STATUS.CONFIRMED;
  if (exC !== inC) {
    const winner = exC ? existing : incoming;
    const loser  = exC ? incoming : existing;
    return { conflict: true, winner, loser, reason: 'confirmed_beats_pending' };
  }

  // 4. Tie-break: keep incumbent.
  return { conflict: true, winner: existing, loser: incoming, reason: 'incumbent_retained' };
}

module.exports = { resolve, slotKey };
