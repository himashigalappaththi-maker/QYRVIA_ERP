'use strict';

/**
 * CheckOutService - ends an active stay.
 *
 * Consumes the Reservation Engine (Phase 12) only: `reservationEngine.complete`
 * drives CHECKED_IN -> COMPLETED, which sends the room to CLEANING via the Room
 * Engine (Phase 11). Supports standard / early / late checkout (late is a flag
 * set before checkout; the actual checkout is the same path).
 *
 * Emits: stay.ended, housekeeping.queued.
 */

const sm = require('./StayStateMachine');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildCheckOutService({ reservationEngine, stayStore, eventBus } = {}) {
  if (!reservationEngine) throw new Error('CheckOutService: reservationEngine required');
  if (!stayStore)         throw new Error('CheckOutService: stayStore required');

  async function emit(type, aggregateType, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType, aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt operational state */ }
  }

  async function loadActiveStay(ctx, reservationId) {
    if (!ctx || !ctx.propertyId) throw new Error('property_required');
    const stay = await stayStore.getByReservation(ctx.propertyId, reservationId);
    if (!stay) throw new Error('stay_not_found');
    return stay;
  }

  return {
    /** Standard / early checkout. `type` defaults to STANDARD. */
    async checkOut(ctx, reservationId, { type = 'STANDARD' } = {}) {
      const stay = await loadActiveStay(ctx, reservationId);
      sm.assertTransition(stay.status, sm.STATES.CHECKED_OUT);   // IN_STAY -> CHECKED_OUT

      // Drive Phase 12 (which sends the room to CLEANING via Phase 11).
      await reservationEngine.complete(ctx, reservationId);

      const out = await stayStore.update(ctx.propertyId, reservationId,
        { status: sm.STATES.CHECKED_OUT, checkOutAt: new Date().toISOString(), checkoutType: type });

      await emit('stay.ended', 'stay', out.stayId,
        { stay_id: out.stayId, reservation_id: reservationId, room_id: out.roomId, checkout_type: type, property_id: ctx.propertyId }, ctx);
      await emit('housekeeping.queued', 'housekeeping', out.roomId,
        { room_id: out.roomId, reservation_id: reservationId, reason: 'checkout', property_id: ctx.propertyId }, ctx);
      return out;
    },

    /** Early checkout: same path, tagged EARLY. */
    async earlyCheckOut(ctx, reservationId) {
      return this.checkOut(ctx, reservationId, { type: 'EARLY' });
    },

    /**
     * Grant a late checkout: records the extension (and emits a late-fee
     * billing hook). The actual checkout still goes through checkOut(LATE).
     */
    async grantLateCheckOut(ctx, reservationId, { until } = {}) {
      const stay = await loadActiveStay(ctx, reservationId);
      if (stay.status !== sm.STATES.IN_STAY) throw new Error('invalid_stay_state: late checkout requires IN_STAY');
      const updated = await stayStore.update(ctx.propertyId, reservationId, { lateCheckoutUntil: until || null });
      await emit('room.charge_started', 'room', updated.roomId,
        { room_id: updated.roomId, reservation_id: reservationId, charge: 'late_checkout', until: until || null, property_id: ctx.propertyId }, ctx);
      return updated;
    }
  };
}

module.exports = { buildCheckOutService };
