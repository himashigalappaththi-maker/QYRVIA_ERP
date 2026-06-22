'use strict';

/**
 * FrontDeskEngine - the operational stay-lifecycle layer.
 *
 *   Reservation (Phase 12) + Room (Phase 11)  --consumed by-->  FrontDeskEngine
 *
 * Composes check-in / check-out and adds room-move + early/late checkout. It
 * ONLY consumes the Reservation and Room engines' public APIs; it never mutates
 * their internals. JS / CommonJS; additive; no schema changes.
 */

const sm = require('./StayStateMachine');
const { buildCheckInService } = require('./CheckInService');
const { buildCheckOutService } = require('./CheckOutService');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildFrontDeskEngine({ reservationEngine, roomEngine, eventBus, idGen } = {}) {
  if (!reservationEngine) throw new Error('FrontDeskEngine: reservationEngine required');
  if (!roomEngine)        throw new Error('FrontDeskEngine: roomEngine required');

  const stayStore = sm.buildMemoryStayStore();
  const checkInService = buildCheckInService({ reservationEngine, stayStore, eventBus, idGen });
  const checkOutService = buildCheckOutService({ reservationEngine, stayStore, eventBus });

  async function emit(type, aggregateType, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType, aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt operational state */ }
  }

  return {
    checkInGuest(ctx, reservationId) { return checkInService.checkIn(ctx, reservationId); },
    checkOutGuest(ctx, reservationId, opts) { return checkOutService.checkOut(ctx, reservationId, opts); },
    earlyCheckOut(ctx, reservationId) { return checkOutService.earlyCheckOut(ctx, reservationId); },
    lateCheckOut(ctx, reservationId, opts) { return checkOutService.grantLateCheckOut(ctx, reservationId, opts); },

    /**
     * Move an in-stay guest to a different room (e.g. upgrade). Consumes the
     * Room Engine: the old room goes to CLEANING, the new room is occupied. The
     * stay's current room is updated; the reservation's booking record is left
     * to Phase 12 (front desk does not mutate it).
     */
    async moveRoom(ctx, reservationId, newRoomId) {
      if (!ctx || !ctx.propertyId) throw new Error('property_required');
      const stay = await stayStore.getByReservation(ctx.propertyId, reservationId);
      if (!stay) throw new Error('stay_not_found');
      if (stay.status !== sm.STATES.IN_STAY) throw new Error('invalid_stay_state: move requires IN_STAY');
      if (!newRoomId || newRoomId === stay.roomId) throw new Error('invalid_target_room');

      await roomEngine.checkOut(ctx, { roomId: stay.roomId });                 // old -> CLEANING
      await roomEngine.checkIn(ctx, { roomId: newRoomId, reservationId });     // new -> OCCUPIED
      const updated = await stayStore.update(ctx.propertyId, reservationId, { roomId: newRoomId });

      await emit('stay.room_moved', 'stay', updated.stayId,
        { stay_id: updated.stayId, reservation_id: reservationId, from_room_id: stay.roomId, to_room_id: newRoomId, property_id: ctx.propertyId }, ctx);
      await emit('housekeeping.queued', 'housekeeping', stay.roomId,
        { room_id: stay.roomId, reservation_id: reservationId, reason: 'room_move', property_id: ctx.propertyId }, ctx);
      return updated;
    },

    async getStay(ctx, reservationId) {
      if (!ctx || !ctx.propertyId) throw new Error('property_required');
      return stayStore.getByReservation(ctx.propertyId, reservationId);
    },
    async listStays(ctx) {
      if (!ctx || !ctx.propertyId) throw new Error('property_required');
      return stayStore.list(ctx.propertyId);
    }
  };
}

module.exports = { buildFrontDeskEngine };
