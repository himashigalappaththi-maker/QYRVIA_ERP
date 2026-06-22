'use strict';

/**
 * RoomInventoryEngine - the truth layer for physical hotel capacity.
 *
 *   const engine = buildRoomInventoryEngine({ store, eventBus });
 *
 * Responsibilities:
 *   - Generate rooms dynamically from a per-property configuration.
 *   - Own the room lifecycle: check-in -> OCCUPIED, check-out -> CLEANING,
 *     cleaning complete -> AVAILABLE, plus MAINTENANCE.
 *   - Reserve (block) rooms for a date range with OVERBOOKING PREVENTION.
 *   - Answer deterministic availability + occupancy queries.
 *   - Emit room.created / room.status_changed / room.occupied / room.cleaned.
 *
 * Multi-property isolation is absolute: every method takes a ctx carrying
 * propertyId, and the store is property-scoped, so no cross-property room is
 * ever visible or mutable.
 *
 * `eventBus` and `idGen` are injectable (pure/testable). Reservation date-range
 * blocks live in-engine for now; persistence + the reservation system land in
 * Phase 12 (the store seam already supports a pg-backed swap for the rooms).
 */

const crypto = require('crypto');
const { makeRoom, STATUS, HOUSEKEEPING } = require('../rooms/RoomModel');
const availability = require('./AvailabilityCalculator');
const occupancy = require('./OccupancyTracker');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* event layer optional */ }

function buildRoomInventoryEngine({ store, eventBus, idGen } = {}) {
  if (!store) throw new Error('RoomInventoryEngine: store required');
  const newId = idGen || (() => crypto.randomUUID());
  const blocks = [];   // { roomId, dateFrom, dateTo, reservationId }

  function requireProperty(ctx) {
    if (!ctx || !ctx.propertyId) throw new Error('property_required');
    return ctx.propertyId;
  }

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try {
      await eventBus.publish(makeEvent({ type, aggregateType: 'room', aggregateId: String(aggregateId), payload, ctx }));
    } catch (_) { /* event failure must not corrupt inventory state */ }
  }

  async function getRoomOrThrow(propertyId, roomId) {
    const room = await store.get(propertyId, roomId);
    if (!room) throw new Error('room_not_found');
    return room;
  }

  async function transition(ctx, roomId, mutate, evType, evPayload) {
    const propertyId = requireProperty(ctx);
    await getRoomOrThrow(propertyId, roomId);                 // isolation + existence
    const patch = mutate();
    const updated = await store.update(propertyId, roomId, patch);
    await emit('room.status_changed', roomId,
      Object.assign({ room_id: roomId, status: updated.status, property_id: propertyId }, evPayload || {}), ctx);
    if (evType) await emit(evType, roomId, Object.assign({ room_id: roomId, property_id: propertyId }, evPayload || {}), ctx);
    return updated;
  }

  return {
    /** Create one room. */
    async createRoom(ctx, fields) {
      const propertyId = requireProperty(ctx);
      const room = makeRoom(Object.assign({ roomId: newId(), propertyId }, fields, { propertyId }));
      const saved = await store.insert(room);
      await emit('room.created', saved.roomId,
        { room_id: saved.roomId, property_id: propertyId, category_id: saved.categoryId,
          floor_id: saved.floorId, room_number: saved.roomNumber }, ctx);
      return saved;
    },

    /**
     * Generate rooms from configuration. Rooms are NOT static.
     * config = [{ categoryId, floorId, floorNumber, count, startSeq? }]
     * roomNumber = floorNumber*100 + seq  (e.g. floor 1 -> 101,102,...).
     */
    async generateRooms(ctx, config = []) {
      const propertyId = requireProperty(ctx);
      const created = [];
      for (const spec of config) {
        if (!spec || !spec.categoryId || !spec.floorId) throw new Error('invalid_config: categoryId + floorId required');
        const floorNumber = Number(spec.floorNumber || 1);
        const start = Number(spec.startSeq || 1);
        const count = Number(spec.count || 0);
        for (let i = 0; i < count; i++) {
          const seq = start + i;
          const roomNumber = String(floorNumber * 100 + seq);
          // eslint-disable-next-line no-await-in-loop
          const saved = await this.createRoom(ctx, {
            categoryId: spec.categoryId, floorId: spec.floorId, roomNumber
          });
          created.push(saved);
        }
      }
      return created;
    },

    async getRoom(ctx, roomId) {
      return store.get(requireProperty(ctx), roomId);
    },

    async listRooms(ctx, filter = {}) {
      return store.list(requireProperty(ctx), filter);
    },

    // ---- lifecycle ----------------------------------------------------------
    async checkIn(ctx, { roomId, reservationId } = {}) {
      const propertyId = requireProperty(ctx);
      const room = await getRoomOrThrow(propertyId, roomId);
      if (room.status !== STATUS.AVAILABLE) throw new Error('invalid_transition: check-in requires AVAILABLE, was ' + room.status);
      return transition(ctx, roomId,
        () => ({ status: STATUS.OCCUPIED, currentReservationId: reservationId || null }),
        'room.occupied', { reservation_id: reservationId || null });
    },

    async checkOut(ctx, { roomId } = {}) {
      const propertyId = requireProperty(ctx);
      const room = await getRoomOrThrow(propertyId, roomId);
      if (room.status !== STATUS.OCCUPIED) throw new Error('invalid_transition: check-out requires OCCUPIED, was ' + room.status);
      return transition(ctx, roomId,
        () => ({ status: STATUS.CLEANING, currentReservationId: null, housekeepingState: HOUSEKEEPING.DIRTY }));
    },

    async cleaningComplete(ctx, { roomId } = {}) {
      const propertyId = requireProperty(ctx);
      const room = await getRoomOrThrow(propertyId, roomId);
      if (room.status !== STATUS.CLEANING) throw new Error('invalid_transition: cleaning-complete requires CLEANING, was ' + room.status);
      return transition(ctx, roomId,
        () => ({ status: STATUS.AVAILABLE, housekeepingState: HOUSEKEEPING.CLEAN }),
        'room.cleaned');
    },

    async setMaintenance(ctx, { roomId } = {}) {
      const propertyId = requireProperty(ctx);
      const room = await getRoomOrThrow(propertyId, roomId);
      if (room.status === STATUS.OCCUPIED) throw new Error('invalid_transition: cannot set MAINTENANCE on OCCUPIED room');
      return transition(ctx, roomId, () => ({ status: STATUS.MAINTENANCE }));
    },

    async clearMaintenance(ctx, { roomId } = {}) {
      const propertyId = requireProperty(ctx);
      const room = await getRoomOrThrow(propertyId, roomId);
      if (room.status !== STATUS.MAINTENANCE) throw new Error('invalid_transition: clear-maintenance requires MAINTENANCE, was ' + room.status);
      return transition(ctx, roomId, () => ({ status: STATUS.AVAILABLE, housekeepingState: HOUSEKEEPING.CLEAN }));
    },

    async inspect(ctx, { roomId } = {}) {
      const propertyId = requireProperty(ctx);
      await getRoomOrThrow(propertyId, roomId);
      return store.update(propertyId, roomId, { housekeepingState: HOUSEKEEPING.INSPECTED });
    },

    // ---- reservation blocking (overbooking prevention) ----------------------
    /**
     * Reserve a room for a date range. Refuses if the room is OCCUPIED,
     * under MAINTENANCE, or already blocked by an overlapping range -
     * guaranteeing no double booking.
     */
    async block(ctx, { roomId, dateFrom, dateTo, reservationId } = {}) {
      const propertyId = requireProperty(ctx);
      if (!dateFrom || !dateTo || !(dateFrom < dateTo)) throw new Error('invalid_date_range');
      const room = await getRoomOrThrow(propertyId, roomId);
      if (!availability.isAvailable(room, blocks, { dateFrom, dateTo })) {
        throw new Error('room_unavailable');     // overbooking prevented
      }
      const blk = { roomId, dateFrom, dateTo, reservationId: reservationId || null };
      blocks.push(blk);
      return blk;
    },

    /** Release a previously held block (e.g. on cancellation). */
    async release(ctx, { roomId, reservationId } = {}) {
      requireProperty(ctx);
      const before = blocks.length;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].roomId === roomId && (reservationId == null || blocks[i].reservationId === reservationId)) {
          blocks.splice(i, 1);
        }
      }
      return { released: before - blocks.length };
    },

    // ---- queries ------------------------------------------------------------
    /** Deterministic availability for a date range (property-scoped). */
    async availability(ctx, { dateFrom, dateTo, categoryId } = {}) {
      const propertyId = requireProperty(ctx);
      const rooms = await store.list(propertyId, categoryId ? { categoryId } : {});
      return availability.availableRooms(rooms, blocks, { dateFrom, dateTo });
    },

    async occupancy(ctx) {
      const propertyId = requireProperty(ctx);
      const rooms = await store.list(propertyId, {});
      return occupancy.snapshot(rooms);
    },

    _blocks: blocks    // exposed for tests/inspection
  };
}

module.exports = { buildRoomInventoryEngine };
