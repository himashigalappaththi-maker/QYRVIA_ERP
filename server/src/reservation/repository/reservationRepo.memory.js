'use strict';

/**
 * In-memory reservation repository (default backing for the Reservation
 * Engine). Defines the persistence seam; a pg-backed repo (additive
 * `reservations` + `reservation_events` tables) can be dropped in later
 * without touching the engine.
 *
 * Property-scoped throughout (multi-property isolation). Also owns the
 * idempotency index and the reservation_events append log.
 */

function buildMemoryReservationRepo() {
  const byId = new Map();          // propertyId|reservationId -> reservation
  const byIdem = new Map();        // propertyId|idempotencyKey -> reservationId
  const events = [];               // reservation_events
  const k = (p, id) => p + '|' + id;

  return {
    async insert(res) {
      byId.set(k(res.propertyId, res.reservationId), Object.assign({}, res));
      byIdem.set(k(res.propertyId, res.idempotencyKey), res.reservationId);
      return Object.assign({}, res);
    },
    async get(propertyId, reservationId) {
      const r = byId.get(k(propertyId, reservationId));
      return r ? Object.assign({}, r) : null;
    },
    async findByIdempotencyKey(propertyId, idempotencyKey) {
      const id = byIdem.get(k(propertyId, idempotencyKey));
      return id ? this.get(propertyId, id) : null;
    },
    async update(propertyId, reservationId, patch) {
      const key = k(propertyId, reservationId);
      const r = byId.get(key);
      if (!r || r.propertyId !== propertyId) return null;          // isolation
      Object.assign(r, patch, { updatedAt: new Date().toISOString() });
      return Object.assign({}, r);
    },
    async list(propertyId, filter = {}) {
      const out = [];
      for (const r of byId.values()) {
        if (r.propertyId !== propertyId) continue;
        if (filter.status && r.status !== filter.status) continue;
        out.push(Object.assign({}, r));
      }
      return out;
    },
    async appendEvent(ev) {
      events.push(Object.assign({ at: new Date().toISOString() }, ev));
    },
    async listEvents(propertyId, reservationId) {
      return events.filter((e) => e.propertyId === propertyId && e.reservationId === reservationId);
    },
    _events: events
  };
}

module.exports = { buildMemoryReservationRepo };
