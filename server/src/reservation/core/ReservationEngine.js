'use strict';

/**
 * ReservationEngine - the system of record for bookings (truth layer).
 *
 *   OTA / Channel Manager
 *        v
 *   ReservationEngine (truth)        <- this module
 *        v
 *   RoomHoldEngine (race protection)
 *        v
 *   RoomInventoryEngine (physical state)
 *
 * Deterministic lifecycle (CREATED -> HELD -> CONFIRMED -> CHECKED_IN ->
 * COMPLETED, plus CONFIRMED -> CANCELLED); invalid transitions throw.
 * Idempotency-safe ingestion (same idempotencyKey returns the existing
 * reservation). Room assignment is race-safe: availability is read from the
 * Room Engine, then an ATOMIC hold is acquired before the reservation is
 * persisted in HELD; on CONFIRM the hold converts to a permanent Room Engine
 * assignment; on any failure the hold is released immediately.
 *
 * The Room Inventory Engine stays a pure physical-state layer - this engine
 * only reads availability and drives block/release + check-in/out.
 */

const crypto = require('crypto');
const { STATUS, assertTransition, makeReservation } = require('../models/ReservationModel');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildReservationEngine({ reservationRepo, holdEngine, roomEngine, eventBus, idGen, clock } = {}) {
  if (!reservationRepo) throw new Error('ReservationEngine: reservationRepo required');
  if (!holdEngine)      throw new Error('ReservationEngine: holdEngine required');
  if (!roomEngine)      throw new Error('ReservationEngine: roomEngine required');
  const newId = idGen || (() => crypto.randomUUID());

  function requireProperty(ctx) {
    if (!ctx || !ctx.propertyId) throw new Error('property_required');
    return ctx.propertyId;
  }

  async function emit(type, reservationId, payload, ctx) {
    await reservationRepo.appendEvent({ propertyId: ctx.propertyId, reservationId, type, payload: payload || {} });
    if (!eventBus || !makeEvent || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType: 'reservation', aggregateId: String(reservationId), payload, ctx })); }
    catch (_) { /* event failure must not corrupt reservation state */ }
  }

  async function getOrThrow(ctx, reservationId) {
    const r = await reservationRepo.get(requireProperty(ctx), reservationId);
    if (!r) throw new Error('reservation_not_found');
    return r;
  }

  return {
    /**
     * Create a reservation. Idempotent on `idempotencyKey`. Acquires an atomic
     * room hold before persisting in HELD. Throws 'no_availability' when no
     * holdable room exists for the requested category + date range.
     */
    async createReservation(ctx, request = {}) {
      const propertyId = requireProperty(ctx);
      if (!request.idempotencyKey) throw new Error('idempotencyKey required');

      const existing = await reservationRepo.findByIdempotencyKey(propertyId, request.idempotencyKey);
      if (existing) return existing;                              // retry-safe

      const range = { dateFrom: request.checkInDate, dateTo: request.checkOutDate };
      if (!range.dateFrom || !range.dateTo || !(range.dateFrom < range.dateTo)) throw new Error('invalid_date_range');

      const available = await roomEngine.availability(ctx, {
        dateFrom: range.dateFrom, dateTo: range.dateTo, categoryId: request.roomCategoryId });
      const candidates = available.filter((r) => !holdEngine.isHeld(propertyId, r.roomId, range));
      if (candidates.length === 0) throw new Error('no_availability');

      const reservationId = newId();
      let hold = null;
      for (const room of candidates) {
        try {
          // eslint-disable-next-line no-await-in-loop
          hold = await holdEngine.createHold(ctx, { roomId: room.roomId, dateFrom: range.dateFrom, dateTo: range.dateTo, reservationId });
          break;
        } catch (e) {
          if (/room_held/.test(e.message)) continue;             // race: try next candidate
          throw e;
        }
      }
      if (!hold) throw new Error('no_availability');              // all candidates raced away

      const res = makeReservation(Object.assign({ reservationId, status: STATUS.CREATED, propertyId }, request), { idGen: newId, clock });
      await reservationRepo.insert(res);
      await emit('reservation.created', reservationId, { source: res.source, property_id: propertyId }, ctx);

      assertTransition(STATUS.CREATED, STATUS.HELD);
      const held = await reservationRepo.update(propertyId, reservationId, { status: STATUS.HELD, heldRoomId: hold.roomId });
      await emit('reservation.held', reservationId, { held_room_id: hold.roomId }, ctx);
      return held;
    },

    /** HELD -> CONFIRMED: convert the hold into a permanent room assignment. */
    async confirm(ctx, reservationId) {
      const propertyId = requireProperty(ctx);
      const res = await getOrThrow(ctx, reservationId);
      assertTransition(res.status, STATUS.CONFIRMED);

      const hold = holdEngine.findByReservation(propertyId, reservationId);
      if (!hold) throw new Error('hold_expired');

      try {
        // Permanent inventory-level assignment (second overbooking guard).
        await roomEngine.block(ctx, { roomId: res.heldRoomId, dateFrom: res.checkInDate, dateTo: res.checkOutDate, reservationId });
      } catch (e) {
        await holdEngine.release(ctx, { reservationId });
        throw e;
      }
      await holdEngine.assign(ctx, { holdId: hold.holdId });      // emits room.assigned

      const confirmed = await reservationRepo.update(propertyId, reservationId,
        { status: STATUS.CONFIRMED, assignedRoomId: res.heldRoomId });
      await emit('reservation.confirmed', reservationId, { assigned_room_id: res.heldRoomId }, ctx);
      return confirmed;
    },

    /** CONFIRMED -> CANCELLED: release the room assignment + any hold. */
    async cancel(ctx, reservationId) {
      const propertyId = requireProperty(ctx);
      const res = await getOrThrow(ctx, reservationId);
      assertTransition(res.status, STATUS.CANCELLED);
      if (res.assignedRoomId) await roomEngine.release(ctx, { roomId: res.assignedRoomId, reservationId });
      await holdEngine.release(ctx, { reservationId });
      const cancelled = await reservationRepo.update(propertyId, reservationId, { status: STATUS.CANCELLED });
      await emit('reservation.cancelled', reservationId, {}, ctx);
      return cancelled;
    },

    /** CONFIRMED -> CHECKED_IN: occupy the assigned room. */
    async checkIn(ctx, reservationId) {
      const propertyId = requireProperty(ctx);
      const res = await getOrThrow(ctx, reservationId);
      assertTransition(res.status, STATUS.CHECKED_IN);
      await roomEngine.checkIn(ctx, { roomId: res.assignedRoomId, reservationId });
      const out = await reservationRepo.update(propertyId, reservationId, { status: STATUS.CHECKED_IN });
      await emit('reservation.checked_in', reservationId, { assigned_room_id: res.assignedRoomId }, ctx);
      return out;
    },

    /** CHECKED_IN -> COMPLETED: check the guest out (room -> CLEANING). */
    async complete(ctx, reservationId) {
      const propertyId = requireProperty(ctx);
      const res = await getOrThrow(ctx, reservationId);
      assertTransition(res.status, STATUS.COMPLETED);
      await roomEngine.checkOut(ctx, { roomId: res.assignedRoomId });
      const out = await reservationRepo.update(propertyId, reservationId, { status: STATUS.COMPLETED });
      await emit('reservation.completed', reservationId, {}, ctx);
      return out;
    },

    async get(ctx, reservationId) { return reservationRepo.get(requireProperty(ctx), reservationId); },
    async list(ctx, filter) { return reservationRepo.list(requireProperty(ctx), filter || {}); }
  };
}

module.exports = { buildReservationEngine };
