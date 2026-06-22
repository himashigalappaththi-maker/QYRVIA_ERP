'use strict';

/**
 * Stay lifecycle state machine (Phase 13 - Front Desk).
 *
 *   RESERVATION_CONFIRMED -> CHECKED_IN -> IN_STAY -> CHECKED_OUT
 *
 * A Stay is the operational record of a guest's physical presence, derived from
 * a CONFIRMED reservation. It is owned by the front desk and never mutates the
 * Reservation (Phase 12) or Room (Phase 11) engines - those are consumed only.
 * Also provides a tiny in-memory, property-scoped stay store.
 */

const crypto = require('crypto');

const STATES = Object.freeze({
  RESERVATION_CONFIRMED: 'RESERVATION_CONFIRMED',
  CHECKED_IN: 'CHECKED_IN',
  IN_STAY: 'IN_STAY',
  CHECKED_OUT: 'CHECKED_OUT'
});

const TRANSITIONS = Object.freeze({
  RESERVATION_CONFIRMED: ['CHECKED_IN'],
  CHECKED_IN: ['IN_STAY'],
  IN_STAY: ['CHECKED_OUT'],
  CHECKED_OUT: []
});

function canTransition(from, to) {
  return !!TRANSITIONS[from] && TRANSITIONS[from].includes(to);
}
function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error('invalid_stay_transition: ' + from + ' -> ' + to);
}

function makeStay(fields = {}, { idGen, clock } = {}) {
  const f = fields || {};
  if (!f.propertyId)    throw new Error('Stay: propertyId required');
  if (!f.reservationId) throw new Error('Stay: reservationId required');
  if (!f.roomId)        throw new Error('Stay: roomId required');
  const iso = new Date(clock ? clock() : Date.now()).toISOString();
  return {
    stayId: f.stayId || (idGen ? idGen() : crypto.randomUUID()),
    propertyId: String(f.propertyId),
    reservationId: String(f.reservationId),
    roomId: String(f.roomId),
    status: f.status || STATES.CHECKED_IN,
    checkInAt: f.checkInAt || iso,
    checkOutAt: f.checkOutAt || null,
    checkoutType: f.checkoutType || null,        // STANDARD | EARLY | LATE
    lateCheckoutUntil: f.lateCheckoutUntil || null,
    createdAt: iso,
    updatedAt: iso
  };
}

/** In-memory, property-scoped stay store (one active stay per reservation). */
function buildMemoryStayStore() {
  const byReservation = new Map();   // propertyId|reservationId -> stay
  const k = (p, r) => p + '|' + r;
  return {
    async insert(stay) { byReservation.set(k(stay.propertyId, stay.reservationId), Object.assign({}, stay)); return Object.assign({}, stay); },
    async getByReservation(propertyId, reservationId) {
      const s = byReservation.get(k(propertyId, reservationId));
      return s ? Object.assign({}, s) : null;
    },
    async update(propertyId, reservationId, patch) {
      const key = k(propertyId, reservationId);
      const s = byReservation.get(key);
      if (!s || s.propertyId !== propertyId) return null;
      Object.assign(s, patch, { updatedAt: new Date().toISOString() });
      return Object.assign({}, s);
    },
    async list(propertyId) {
      const out = [];
      for (const s of byReservation.values()) if (s.propertyId === propertyId) out.push(Object.assign({}, s));
      return out;
    }
  };
}

module.exports = { STATES, TRANSITIONS, canTransition, assertTransition, makeStay, buildMemoryStayStore };
