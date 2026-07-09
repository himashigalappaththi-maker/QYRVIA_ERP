'use strict';

/**
 * BookingService (Booking Engine v1) - the single orchestration gate for ALL
 * reservation creation (Direct / OTA / AI / Front Desk).
 *
 * Pipeline: input -> availability -> pricing -> validator -> commandBus -> PMS.
 * Stateless orchestration; every write goes through commandBus.dispatch (no direct
 * PMS dependency, no schema change). Idempotency is INHERITED from booking_store
 * (UNIQUE tenant+channel+external_ref): a duplicate external_ref routes to UPDATE,
 * never a second CREATE. Events are metadata-only.
 */

const { buildPricingEngine } = require('./pricingEngine');
const { buildAvailabilityEngine } = require('./availabilityEngine');
const { buildBookingValidator } = require('./bookingValidator');

function buildBookingService({ commandBus, availabilityEngine, pricingEngine, validator, bookingStore, rateResolver, inventoryAdjuster, commandMap, onEvent } = {}) {
  if (!commandBus) throw new Error('bookingService: commandBus required');
  const av = availabilityEngine || buildAvailabilityEngine({});
  const pr = pricingEngine || buildPricingEngine({});
  const val = validator || buildBookingValidator({});
  const cmds = Object.assign({ create: 'pms.reservation.create', update: 'pms.reservation.update', cancel: 'pms.reservation.cancel' }, commandMap || {});
  const resolveRate = rateResolver || ((input) => Number(input.base_rate != null ? input.base_rate : input.rate_amount) || 0);
  // inventoryAdjuster: no-op default so existing tests see no change
  const adjuster = inventoryAdjuster || { async adjustSold() {} };

  function emit(type, meta) { if (typeof onEvent === 'function') { try { onEvent(Object.assign({ type }, meta)); } catch (_) { /* never throws */ } } }
  function nights(input) {
    try { const d = Math.round((new Date(input.departure) - new Date(input.arrival)) / 86400000); return d >= 1 ? d : 1; }
    catch (_) { return 1; }
  }
  function mapInput(input, pricing) {
    return {
      external_ref: input.external_ref || input.bookingId || null, room_type_id: input.room_type_id,
      arrival_date: input.arrival, departure_date: input.departure, adults: input.adults, children: input.children || 0,
      guest_name: input.guest_name || null, amount: pricing ? pricing.total : null,
      currency: (pricing && pricing.currency) || input.currency || 'USD', source_channel: input.channel || 'DIRECT'
    };
  }
  async function dispatch(name, payload, ctx) {
    try { return await commandBus.dispatch(name, payload, ctx); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function createBooking(input, ctx) {
    if (!ctx || !ctx.tenantId) return { ok: false, reason: 'tenant_required' };
    input = input || {};
    const channel = input.channel || 'DIRECT';
    const external_ref = input.external_ref || input.bookingId || null;

    // idempotency: an existing external_ref => UPDATE, never a second CREATE
    if (bookingStore && external_ref) {
      const existing = await Promise.resolve(bookingStore.getByExternalRef(ctx.tenantId, channel, external_ref));
      if (existing) return updateBooking(Object.assign({}, input, { reservation_id: existing.pms_reservation_id }), ctx);
    }

    const availability = await av.check(ctx, input);
    // Enrich the rate resolver input with ctx.tenantId / ctx.propertyId so async
    // resolvers (e.g. ariRateResolver) can scope their store lookup. The flat
    // synchronous resolver ignores these extra fields — no behavior change.
    const rateInput = Object.assign({}, input, { tenantId: ctx.tenantId, propertyId: ctx.propertyId || null });
    const pricing = pr.quote({ ratePerNight: await resolveRate(rateInput), nights: nights(input), discounts: input.discounts || 0, currency: input.currency });
    const v = val.validate(input, { availability, pricing });
    if (!v.ok) { emit('booking.rejected', { tenant_id: ctx.tenantId, channel, external_ref, reason: v.reason, detail: v.detail }); return { ok: false, reason: v.reason, detail: v.detail }; }

    const res = await dispatch(cmds.create, mapInput(input, pricing), ctx);
    if (!res || !res.ok) { emit('booking.rejected', { tenant_id: ctx.tenantId, channel, external_ref, reason: 'PMS_DISPATCH_FAILED' }); return { ok: false, reason: 'PMS_DISPATCH_FAILED', error: res && res.error }; }
    const reservation_id = (res.result && (res.result.id || res.result.reservation_id)) || res.id || null;

    if (bookingStore && external_ref) {
      const up = await Promise.resolve(bookingStore.upsert({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId || null, channel, external_ref, status: 'CONFIRMED',
        room_type_id: input.room_type_id, arrival: input.arrival, departure: input.departure,
        amount: pricing.total, currency: pricing.currency, source_channel: channel
      }));
      if (reservation_id && up.item && !up.item.pms_reservation_id) await Promise.resolve(bookingStore.setPmsReservationId(up.item.id, reservation_id));
    }

    // D3: adjust ARI inventory after successful PMS dispatch (fresh CREATE only, never idempotency/update path)
    try {
      const adjResult = await adjuster.adjustSold({
        tenantId:   ctx.tenantId,
        propertyId: ctx.propertyId || null,
        roomTypeId: input.room_type_id,
        arrival:    input.arrival,
        departure:  input.departure,
        delta: +1
      });
      if (adjResult === null) {
        // sold floor guard hit — log but do NOT roll back the PMS reservation
        const logger = require('../config/logger');
        logger.warn({ tenantId: ctx.tenantId, roomTypeId: input.room_type_id }, '[bookingService] adjustSold returned null after create (floor guard)');
      }
    } catch (adjErr) {
      // adjustSold failure must never fail the booking
      try { const logger = require('../config/logger'); logger.error({ err: adjErr, tenantId: ctx.tenantId }, '[bookingService] adjustSold threw after create — booking confirmed anyway'); } catch (_) { /* never */ }
    }

    emit('booking.created', { tenant_id: ctx.tenantId, channel, external_ref, reservation_id, total: pricing.total, currency: pricing.currency });
    return { ok: true, reservation_id, pricing };
  }

  async function updateBooking(input, ctx) {
    if (!ctx || !ctx.tenantId) return { ok: false, reason: 'tenant_required' };
    input = input || {};
    const pricing = pr.quote({ ratePerNight: resolveRate(input), nights: nights(input), discounts: input.discounts || 0, currency: input.currency });
    const payload = mapInput(input, pricing);
    if (input.reservation_id) payload.reservation_id = input.reservation_id;
    const res = await dispatch(cmds.update, payload, ctx);
    if (!res || !res.ok) return { ok: false, reason: 'PMS_DISPATCH_FAILED', error: res && res.error };
    emit('booking.updated', { tenant_id: ctx.tenantId, channel: input.channel || 'DIRECT', external_ref: input.external_ref || null, reservation_id: input.reservation_id || null });
    return { ok: true, action: 'update', reservation_id: input.reservation_id || (res.result && res.result.id) || null, pricing };
  }

  async function cancelBooking(input, ctx) {
    if (!ctx || !ctx.tenantId) return { ok: false, reason: 'tenant_required' };
    input = input || {};
    const res = await dispatch(cmds.cancel, { reservation_id: input.reservation_id || null, external_ref: input.external_ref || null }, ctx);
    if (!res || !res.ok) return { ok: false, reason: 'PMS_DISPATCH_FAILED', error: res && res.error };

    // D3: restore ARI inventory after successful cancel dispatch
    if (input.room_type_id && input.arrival && input.departure) {
      try {
        const adjResult = await adjuster.adjustSold({
          tenantId:   ctx.tenantId,
          propertyId: ctx.propertyId || null,
          roomTypeId: input.room_type_id,
          arrival:    input.arrival,
          departure:  input.departure,
          delta: -1
        });
        if (adjResult === null) {
          const logger = require('../config/logger');
          logger.warn({ tenantId: ctx.tenantId, roomTypeId: input.room_type_id }, '[bookingService] adjustSold returned null after cancel (floor guard)');
        }
      } catch (adjErr) {
        try { const logger = require('../config/logger'); logger.error({ err: adjErr, tenantId: ctx.tenantId }, '[bookingService] adjustSold threw after cancel — cancel confirmed anyway'); } catch (_) { /* never */ }
      }
    }

    emit('booking.cancelled', { tenant_id: ctx.tenantId, channel: input.channel || 'DIRECT', external_ref: input.external_ref || null, reservation_id: input.reservation_id || null });
    return { ok: true, action: 'cancel' };
  }

  return { createBooking, updateBooking, cancelBooking };
}

module.exports = { buildBookingService };
