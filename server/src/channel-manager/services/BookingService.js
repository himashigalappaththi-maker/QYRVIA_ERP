'use strict';

/**
 * BookingService - ingests canonical bookings idempotently, detects slot
 * conflicts via ConflictResolver, and provides a replay reducer so booking
 * state can be rebuilt from the persisted event log (event_store).
 */

const conflictResolver = require('./ConflictResolver');
const { BOOKING_STATUS } = require('../core/canonical/types');
const { EVENT_TYPES } = require('../core/events/EventTypes');

function buildBookingService() {
  const byId = new Map();          // bookingId -> canonical
  const conflicts = [];            // recorded conflicts

  function confirmedOnSlot(slot, excludeId) {
    for (const b of byId.values()) {
      if (b.bookingId === excludeId) continue;
      if (b.status !== BOOKING_STATUS.CONFIRMED) continue;
      if (conflictResolver.slotKey(b) === slot) return b;
    }
    return null;
  }

  return {
    /** Idempotent ingest. Returns {action, conflict?}. */
    ingest(canonical) {
      const existing = byId.get(canonical.bookingId);
      if (existing && existing.status === canonical.status) {
        return { action: 'deduped', booking: existing };
      }

      let conflict = null;
      if (canonical.status === BOOKING_STATUS.CONFIRMED) {
        const slot = conflictResolver.slotKey(canonical);
        const incumbent = confirmedOnSlot(slot, canonical.bookingId);
        if (incumbent) {
          const r = conflictResolver.resolve(incumbent, canonical);
          if (r.conflict) {
            conflict = { reason: r.reason, winner: r.winner.bookingId,
              winnerChannel: r.winner.channel, loser: r.loser && r.loser.bookingId };
            conflicts.push(conflict);
          }
        }
      }

      byId.set(canonical.bookingId, canonical);
      return { action: existing ? 'updated' : 'created', booking: canonical, conflict };
    },

    get(id) { return byId.get(id) || null; },
    list() { return Array.from(byId.values()); },
    conflicts() { return conflicts.slice(); },
    count() { return byId.size; },

    /**
     * Pure reducer for event replay. State is a plain object so it round-trips
     * through JSON / event_store. Applying the same event twice is a no-op.
     */
    reducer(state, event) {
      const s = state || { bookings: {} };
      const p = (event && event.payload) || {};
      const id = p.booking_id;
      if (!id) return s;
      const bookings = Object.assign({}, s.bookings);
      switch (event.event_type) {
        case EVENT_TYPES.BOOKING_CREATED:
          bookings[id] = { id, channel: p.channel, status: p.status || BOOKING_STATUS.PENDING };
          break;
        case EVENT_TYPES.BOOKING_CONFIRMED:
          bookings[id] = Object.assign({ id, channel: p.channel }, bookings[id], { status: BOOKING_STATUS.CONFIRMED });
          break;
        case EVENT_TYPES.BOOKING_CANCELLED:
          bookings[id] = Object.assign({ id, channel: p.channel }, bookings[id], { status: BOOKING_STATUS.CANCELLED });
          break;
        default:
          return s;
      }
      return { bookings };
    }
  };
}

module.exports = { buildBookingService };
