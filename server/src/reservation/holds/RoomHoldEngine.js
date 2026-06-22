'use strict';

/**
 * RoomHoldEngine - the temporary-lock layer that sits between the Reservation
 * Engine (truth) and the Room Inventory Engine (physical state).
 *
 * A HOLD is a short-lived, TTL-based lock on a room for a date range. It exists
 * to close the race window between an availability check and a reservation
 * commit. Guarantees:
 *   - **Atomic acquisition**: the overlap check and the insert happen in one
 *     synchronous critical section (no `await` between them), so two concurrent
 *     callers can never both hold the same room+range. (Node is single-threaded;
 *     a synchronous section cannot be interleaved.)
 *   - **No overlapping active holds** per room (ACTIVE or ASSIGNED block; only
 *     RELEASED/EXPIRED free the slot).
 *   - **Expiry**: ACTIVE holds past their TTL are reclaimable via `expire()`.
 *   - **Property-scoped**: holds never cross properties.
 *
 * Emits: room.hold_created, room.hold_released, room.assigned.
 * `eventBus`, `clock`, and `ttlMs` are injectable for deterministic tests.
 */

const crypto = require('crypto');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

const HOLD_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', ASSIGNED: 'ASSIGNED', RELEASED: 'RELEASED', EXPIRED: 'EXPIRED' });

function overlap(aFrom, aTo, bFrom, bTo) { return aFrom < bTo && aTo > bFrom; }

function buildRoomHoldEngine({ eventBus, clock, ttlMs, idGen } = {}) {
  const now = clock || (() => Date.now());
  const ttl = ttlMs != null ? ttlMs : 15 * 60 * 1000;
  const newId = idGen || (() => crypto.randomUUID());
  const holds = [];

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType: 'room', aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* event failure must not corrupt hold state */ }
  }

  function isActive(h) {
    if (h.status === HOLD_STATUS.ASSIGNED) return true;
    return h.status === HOLD_STATUS.ACTIVE && h.expiresAt > now();
  }

  function blockingOverlap(propertyId, roomId, dateFrom, dateTo) {
    return holds.some((h) => h.propertyId === propertyId && h.roomId === roomId
      && isActive(h) && overlap(dateFrom, dateTo, h.dateFrom, h.dateTo));
  }

  return {
    HOLD_STATUS,

    /** Atomic hold acquisition. Throws 'room_held' if an overlapping active hold exists. */
    async createHold(ctx, { roomId, dateFrom, dateTo, reservationId } = {}) {
      const propertyId = ctx && ctx.propertyId;
      if (!propertyId) throw new Error('property_required');
      if (!roomId || !dateFrom || !dateTo || !(dateFrom < dateTo)) throw new Error('invalid_hold_request');

      // --- critical section: check + insert, strictly synchronous ----------
      if (blockingOverlap(propertyId, roomId, dateFrom, dateTo)) throw new Error('room_held');
      const hold = { holdId: newId(), propertyId, roomId, dateFrom, dateTo,
        reservationId: reservationId || null, status: HOLD_STATUS.ACTIVE, createdAt: now(), expiresAt: now() + ttl };
      holds.push(hold);
      // --- end critical section -------------------------------------------

      await emit('room.hold_created', roomId,
        { hold_id: hold.holdId, property_id: propertyId, room_id: roomId, reservation_id: hold.reservationId,
          date_from: dateFrom, date_to: dateTo, expires_at: hold.expiresAt }, ctx);
      return hold;
    },

    isHeld(propertyId, roomId, range = {}) {
      if (!range.dateFrom || !range.dateTo) return false;
      return blockingOverlap(propertyId, roomId, range.dateFrom, range.dateTo);
    },

    findByReservation(propertyId, reservationId) {
      return holds.find((h) => h.propertyId === propertyId && h.reservationId === reservationId && isActive(h)) || null;
    },

    /** Convert a hold into a permanent assignment. */
    async assign(ctx, { holdId } = {}) {
      const h = holds.find((x) => x.holdId === holdId);
      if (!h) throw new Error('hold_not_found');
      h.status = HOLD_STATUS.ASSIGNED;
      await emit('room.assigned', h.roomId,
        { hold_id: h.holdId, property_id: h.propertyId, room_id: h.roomId, reservation_id: h.reservationId }, ctx);
      return h;
    },

    /** Release hold(s) by holdId or by reservationId. */
    async release(ctx, { holdId, reservationId } = {}) {
      let released = 0;
      for (const h of holds) {
        const match = (holdId && h.holdId === holdId) || (reservationId && h.reservationId === reservationId);
        if (match && (h.status === HOLD_STATUS.ACTIVE || h.status === HOLD_STATUS.ASSIGNED)) {
          h.status = HOLD_STATUS.RELEASED;
          released += 1;
          // eslint-disable-next-line no-await-in-loop
          await emit('room.hold_released', h.roomId,
            { hold_id: h.holdId, property_id: h.propertyId, room_id: h.roomId, reservation_id: h.reservationId }, ctx);
        }
      }
      return { released };
    },

    /** Reclaim ACTIVE holds past their TTL. Returns the count expired. */
    async expire(ctx) {
      let expired = 0;
      for (const h of holds) {
        if (h.status === HOLD_STATUS.ACTIVE && h.expiresAt <= now()) {
          h.status = HOLD_STATUS.EXPIRED;
          expired += 1;
          // eslint-disable-next-line no-await-in-loop
          await emit('room.hold_released', h.roomId,
            { hold_id: h.holdId, property_id: h.propertyId, room_id: h.roomId, reservation_id: h.reservationId, reason: 'expired' }, ctx);
        }
      }
      return { expired };
    },

    activeHolds(propertyId) {
      return holds.filter((h) => h.propertyId === propertyId && isActive(h)).map((h) => Object.assign({}, h));
    },
    _holds: holds
  };
}

module.exports = { buildRoomHoldEngine };
