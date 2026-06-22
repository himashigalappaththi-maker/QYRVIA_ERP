'use strict';

/**
 * Canonical Reservation model (Phase 12 - Reservation Core, the system of
 * record for bookings). Self-contained / additive; JS / CommonJS.
 */

const STATUS = Object.freeze({
  CREATED: 'CREATED',
  HELD: 'HELD',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  CHECKED_IN: 'CHECKED_IN',
  COMPLETED: 'COMPLETED'
});

// Deterministic lifecycle. Anything not listed is invalid and must throw.
const TRANSITIONS = Object.freeze({
  CREATED: ['HELD'],
  HELD: ['CONFIRMED'],
  CONFIRMED: ['CANCELLED', 'CHECKED_IN'],
  CHECKED_IN: ['COMPLETED'],
  CANCELLED: [],
  COMPLETED: []
});

function canTransition(from, to) {
  return !!TRANSITIONS[from] && TRANSITIONS[from].includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error('invalid_transition: ' + from + ' -> ' + to);
  }
}

function makeReservation(fields = {}, { idGen, clock } = {}) {
  const f = fields || {};
  if (!f.propertyId)     throw new Error('Reservation: propertyId required');
  if (!f.source)         throw new Error('Reservation: source required');
  if (!f.checkInDate || !f.checkOutDate) throw new Error('Reservation: check-in/out dates required');
  if (!(f.checkInDate < f.checkOutDate)) throw new Error('Reservation: checkInDate must be before checkOutDate');
  if (!f.roomCategoryId) throw new Error('Reservation: roomCategoryId required');
  if (!f.idempotencyKey) throw new Error('Reservation: idempotencyKey required');
  const now = (clock ? clock() : Date.now());
  const iso = new Date(now).toISOString();

  return {
    reservationId: f.reservationId || (idGen ? idGen() : require('crypto').randomUUID()),
    propertyId: String(f.propertyId),
    guestId: f.guestId || null,
    source: f.source,
    status: f.status || STATUS.CREATED,
    checkInDate: f.checkInDate,
    checkOutDate: f.checkOutDate,
    roomCategoryId: String(f.roomCategoryId),
    heldRoomId: f.heldRoomId || null,
    assignedRoomId: f.assignedRoomId || null,
    guests: { adults: (f.guests && f.guests.adults) || 1, children: (f.guests && f.guests.children) || 0 },
    pricing: {
      baseRate: (f.pricing && Number(f.pricing.baseRate)) || 0,
      taxes: (f.pricing && Number(f.pricing.taxes)) || 0,
      total: (f.pricing && Number(f.pricing.total)) || 0
    },
    idempotencyKey: String(f.idempotencyKey),
    createdAt: iso,
    updatedAt: iso
  };
}

module.exports = { STATUS, TRANSITIONS, canTransition, assertTransition, makeReservation };
