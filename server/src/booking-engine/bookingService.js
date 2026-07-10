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
 *
 * Phase 54 D5: two-phase booking — initiateBooking + confirmBooking.
 * Phase 54 D6: holdEngine DI slot (eager expire of stale holds in initiateBooking).
 */

const { buildPricingEngine } = require('./pricingEngine');
const { buildAvailabilityEngine } = require('./availabilityEngine');
const { buildBookingValidator } = require('./bookingValidator');
const { sanitizePaymentPayload } = require('../payment/sanitizePaymentPayload');

function buildBookingService({
  commandBus, availabilityEngine, pricingEngine, validator, bookingStore,
  rateResolver, inventoryAdjuster, commandMap, onEvent,
  paymentProvider = null,
  paymentStateStore = null,
  paymentAttemptLog = null,
  holdEngine = null,
} = {}) {
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
      holder_guest_id: input.holder_guest_id || null,
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

  // ---- Phase 54 D5: two-phase booking flow ----------------------------------

  async function initiateBooking(input, ctx) {
    const tenantId = ctx && ctx.tenantId;
    const propertyId = (ctx && ctx.propertyId) || (input && input.propertyId) || null;
    input = input || {};

    // 1. Availability check
    const availability = await av.check(ctx, input);
    if (!availability.available) {
      emit('booking.rejected', { tenantId, channel: input.channel, reason: availability.reason || 'no_availability' });
      return { ok: false, reason: 'AVAILABILITY_FAILED', detail: [{ reason: availability.reason || 'no_availability' }] };
    }

    // 2. Rate resolution
    const rateInput = Object.assign({}, input, { tenantId, propertyId });
    const ratePerNight = await resolveRate(rateInput);

    // 3. Pricing
    const los = (() => {
      try {
        const a = new Date(input.arrival); const d = new Date(input.departure);
        const n = Math.round((d - a) / 86400000);
        return n >= 1 ? n : 1;
      } catch (_) { return 1; }
    })();
    const pricing = pr.quote({ ratePerNight, nights: los, discounts: input.discounts || [], currency: input.currency || 'USD' });

    // 4. Validation
    const validation = val.validate(input, { availability, pricing });
    if (!validation.ok) {
      return { ok: false, reason: validation.reason, detail: validation.detail };
    }

    // 5. PMS reservation create (INQUIRY status)
    const pmsResult = await dispatch(cmds.create, mapInput(input, pricing), ctx);
    if (!pmsResult || !pmsResult.ok) {
      return { ok: false, reason: (pmsResult && pmsResult.error) || 'pms_create_failed' };
    }
    const reservationId = (pmsResult.result && (pmsResult.result.id || pmsResult.result.reservation_id)) || null;

    // 6. Payment initiation
    const holdTtlMs = (parseInt(process.env.PAYMENT_HOLD_TTL_SECONDS || '900', 10)) * 1000;
    const holdExpiresAt = new Date(Date.now() + holdTtlMs).toISOString();

    let paymentResult = { ok: false, paymentId: null, provider: 'mock' };
    if (paymentProvider) {
      try {
        paymentResult = await paymentProvider.initiate({
          amount: pricing.total,
          currency: pricing.currency,
          bookingRef: reservationId,
          guestEmail: input.guest_email || null,
          metadata: { tenantId, propertyId, channel: input.channel || 'DIRECT' },
        });
      } catch (err) {
        // swallow — still creates reservation; payment can be retried
        try {
          const logger = require('../config/logger');
          logger.warn({ tenantId, reservationId }, '[bookingService] payment initiate threw — reservation created, payment pending retry');
        } catch (_) { /* never */ }
      }
    }

    // 7. Log attempt
    if (paymentAttemptLog && reservationId) {
      try {
        await paymentAttemptLog.insert({
          tenant_id: tenantId, property_id: propertyId, reservation_id: reservationId,
          provider: (paymentResult && paymentResult.provider) || 'mock',
          amount: pricing.total, currency: pricing.currency,
          status: (paymentResult && paymentResult.ok) ? 'initiated' : 'failed',
          provider_ref: (paymentResult && paymentResult.paymentId) || null,
        }, ctx);
      } catch (_) {}
    }

    // 8. Payment state
    if (paymentStateStore && reservationId) {
      try {
        await paymentStateStore.upsert({
          tenant_id: tenantId, property_id: propertyId,
          reservation_id: reservationId,
          payment_status: 'pending_payment',
          deposit_amount: pricing.total,
          deposit_currency: pricing.currency,
          hold_expires_at: holdExpiresAt,
          provider: (paymentResult && paymentResult.provider) || 'mock',
          provider_ref: (paymentResult && paymentResult.paymentId) || null,
        }, ctx);
      } catch (_) {}
    }

    // 9. Hold engine (lazy expire stale holds) — D6
    if (holdEngine) {
      try { await holdEngine.expire(ctx); } catch (_) {}
    }

    emit('booking.payment_initiated', { tenantId, channel: input.channel, reservationId, total: pricing.total, currency: pricing.currency });

    return {
      ok: true,
      result: {
        reservation_id:  reservationId,
        payment_id:      (paymentResult && paymentResult.paymentId) || null,
        client_secret:   (paymentResult && paymentResult.clientSecret) || null,
        total:           pricing.total,
        currency:        pricing.currency,
        hold_expires_at: holdExpiresAt,
        action:          'initiate_payment',
      },
    };
  }

  async function confirmBooking({ reservationId, paymentId, roomTypeId, arrival, departure, adults }, ctx) {
    const tenantId = ctx && ctx.tenantId;
    const propertyId = (ctx && ctx.propertyId) || null;

    // 1. Check payment state
    let paymentState = null;
    if (paymentStateStore) {
      paymentState = await paymentStateStore.getByReservationId(reservationId, ctx);
    }
    if (paymentState && paymentState.payment_status !== 'pending_payment') {
      return { ok: false, reason: 'invalid_payment_state', detail: [{ state: paymentState.payment_status }] };
    }

    // 2. Check hold not expired
    if (paymentState && paymentState.hold_expires_at) {
      if (new Date(paymentState.hold_expires_at).getTime() < Date.now()) {
        if (paymentStateStore) {
          await paymentStateStore.upsert({ reservation_id: reservationId, payment_status: 'failed', failed_at: new Date().toISOString() }, ctx).catch(() => {});
        }
        return { ok: false, reason: 'hold_expired' };
      }
    }

    // 3. Verify payment
    let verifyResult = { ok: true, status: 'paid' };
    if (paymentProvider && paymentId) {
      try {
        verifyResult = await paymentProvider.verify({ paymentId });
      } catch (err) {
        verifyResult = { ok: false, status: 'failed' };
      }
    }

    // 4. Log attempt
    if (paymentAttemptLog) {
      try {
        await paymentAttemptLog.insert({
          tenant_id: tenantId, property_id: propertyId, reservation_id: reservationId,
          provider: (paymentState && paymentState.provider) || 'mock',
          amount: paymentState ? paymentState.deposit_amount : null,
          currency: paymentState ? paymentState.deposit_currency : null,
          status: (verifyResult.ok && verifyResult.status === 'paid') ? 'success' : 'failed',
          provider_ref: paymentId || null,
        }, ctx);
      } catch (_) {}
    }

    if (!verifyResult.ok || verifyResult.status !== 'paid') {
      if (paymentStateStore) {
        await paymentStateStore.upsert({ reservation_id: reservationId, payment_status: 'failed', failed_at: new Date().toISOString() }, ctx).catch(() => {});
      }
      return { ok: false, reason: 'payment_verification_failed', detail: [{ status: verifyResult.status }] };
    }

    // 5. PMS confirm (INQUIRY -> CONFIRMED)
    const pmsConfirm = await dispatch('pms.reservation.confirm', { reservation_id: reservationId }, ctx);
    if (!pmsConfirm || !pmsConfirm.ok) {
      return { ok: false, reason: (pmsConfirm && pmsConfirm.error) || 'pms_confirm_failed' };
    }

    // 6. ARI inventory adjustment (ceiling-guarded in adjuster)
    if (adjuster && roomTypeId && arrival && departure) {
      try {
        await adjuster.adjustSold({ tenantId, propertyId, roomTypeId, arrival, departure, delta: +1 });
      } catch (_) {}
    }

    // 7. Update payment state
    if (paymentStateStore) {
      await paymentStateStore.upsert({
        reservation_id: reservationId,
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
        provider_ref: paymentId || null,
      }, ctx).catch(() => {});
    }

    emit('booking.created', { tenantId, channel: 'DIRECT', reservationId, action: 'confirmed_with_payment' });

    return { ok: true, result: { reservation_id: reservationId, action: 'confirm' } };
  }

  return { createBooking, updateBooking, cancelBooking, initiateBooking, confirmBooking };
}

module.exports = { buildBookingService };
