'use strict';

/**
 * CheckInService - turns a CONFIRMED reservation into an active stay.
 *
 * Consumes the Reservation Engine (Phase 12) only: `reservationEngine.checkIn`
 * drives the reservation CONFIRMED -> CHECKED_IN transition, which in turn
 * occupies the room via the Room Engine (Phase 11). The front desk never
 * mutates those engines directly.
 *
 * Emits: stay.started, room.charge_started (billing hook prep).
 */

const crypto = require('crypto');
const sm = require('./StayStateMachine');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildCheckInService({ reservationEngine, stayStore, eventBus, idGen } = {}) {
  if (!reservationEngine) throw new Error('CheckInService: reservationEngine required');
  if (!stayStore)         throw new Error('CheckInService: stayStore required');
  const newId = idGen || (() => crypto.randomUUID());

  async function emit(type, aggregateType, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType, aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt operational state */ }
  }

  return {
    async checkIn(ctx, reservationId) {
      if (!ctx || !ctx.propertyId) throw new Error('property_required');
      const reservation = await reservationEngine.get(ctx, reservationId);
      if (!reservation) throw new Error('reservation_not_found');
      if (reservation.status !== 'CONFIRMED') throw new Error('reservation_not_confirmed');

      // Drive Phase 12 (which occupies the room via Phase 11).
      await reservationEngine.checkIn(ctx, reservationId);

      // Create the stay and advance CHECKED_IN -> IN_STAY.
      let stay = sm.makeStay({
        stayId: newId(), propertyId: ctx.propertyId, reservationId,
        roomId: reservation.assignedRoomId, status: sm.STATES.CHECKED_IN
      });
      await stayStore.insert(stay);
      sm.assertTransition(sm.STATES.CHECKED_IN, sm.STATES.IN_STAY);
      stay = await stayStore.update(ctx.propertyId, reservationId, { status: sm.STATES.IN_STAY });

      await emit('stay.started', 'stay', stay.stayId,
        { stay_id: stay.stayId, reservation_id: reservationId, room_id: stay.roomId, property_id: ctx.propertyId }, ctx);
      await emit('room.charge_started', 'room', stay.roomId,
        { stay_id: stay.stayId, reservation_id: reservationId, room_id: stay.roomId, property_id: ctx.propertyId }, ctx);
      return stay;
    }
  };
}

module.exports = { buildCheckInService };
