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
  findReservationByIdempotencyKey = null,
  confirmationDeliveryService = null,
  // Phase 63 P0-3: payment-confirmation policy. Default TRUE — confirmBooking
  // must never turn a reservation into CONFIRMED without positive payment
  // evidence. Set false ONLY for a deployment that deliberately takes no
  // payment at booking time (front-desk / pay-on-arrival), and say so in the
  // deployment record.
  requirePayment = true,
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
  // Phase 63 P0-4 — the PMS create/update contract was only half-populated.
  //
  // `pms.reservation.create` requires BOTH holder_guest_id AND
  // primary_adult_guest_id (src/commands/pms/index.js — both go through
  // _strReq, which throws on a missing value and is caught as
  // 'validation_failed'). mapInput never emitted primary_adult_guest_id at all,
  // so every booking routed through the REAL command bus failed. Only the unit
  // tests passed, because they all dispatch into a fake command bus.
  //
  // The same omission silently dropped:
  //   rooms_count    -> repos.js defaults to 1, so a 3-room request booked 1 room
  //   rate_plan_id   -> ARI pricing/availability cannot resolve the plan
  //   child_policy_id / child_ages -> the occupancy + child capacity check in
  //                     the create handler is gated on child_policy_id, so it
  //                     never ran
  //   reservation_type / notes / allocation / contract / group linkage
  function mapInput(input, pricing) {
    return {
      external_ref: input.external_ref || input.bookingId || null, room_type_id: input.room_type_id,
      arrival_date: input.arrival, departure_date: input.departure, adults: input.adults, children: input.children || 0,
      holder_guest_id: input.holder_guest_id || null,
      // Fall back to the holder when a distinct primary adult is not supplied:
      // for a direct single-guest booking the holder IS the primary adult.
      primary_adult_guest_id: input.primary_adult_guest_id || input.holder_guest_id || null,
      rooms_count:      input.rooms_count || 1,
      rate_plan_id:     input.rate_plan_id || null,
      child_policy_id:  input.child_policy_id || null,
      child_ages:       Array.isArray(input.child_ages) ? input.child_ages : null,
      reservation_type: input.reservation_type || null,
      notes:            input.notes || null,
      allocation_id:    input.allocation_id || null,
      contract_id:      input.contract_id || null,
      group_id:         input.group_id || null,
      guest_name: input.guest_name || null, amount: pricing ? pricing.total : null,
      currency: (pricing && pricing.currency) || input.currency || 'USD', source_channel: input.channel || 'DIRECT',
      idempotency_key: input.idempotency_key || null,
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

    // Phase 55: idempotency pre-check using caller-supplied key.
    // pending_payment => return existing result (idempotent)
    // paid            => reject: booking already confirmed
    // failed          => reject: payment already failed (client must use a new key)
    const idempotencyKey = input.idempotency_key || null;
    if (idempotencyKey && typeof findReservationByIdempotencyKey === 'function') {
      try {
        const existing = await findReservationByIdempotencyKey(tenantId, idempotencyKey);
        if (existing) {
          const paymentState = paymentStateStore
            ? await paymentStateStore.getByReservationId(existing.id, ctx)
            : null;
          const ps = paymentState && paymentState.payment_status;
          if (ps === 'paid') {
            return { ok: false, reason: 'booking_already_confirmed' };
          }
          if (ps === 'failed') {
            return { ok: false, reason: 'payment_already_failed' };
          }
          return {
            ok: true,
            result: {
              reservation_id:  existing.id,
              payment_id:      (paymentState && paymentState.provider_ref) || null,
              client_secret:   null,
              total:           (paymentState && paymentState.deposit_amount) || null,
              currency:        (paymentState && paymentState.deposit_currency) || null,
              hold_expires_at: (paymentState && paymentState.hold_expires_at) || null,
              action:          'initiate_payment',
              idempotent:      true,
            },
          };
        }
      } catch (idemErr) {
        try {
          const logger = require('../config/logger');
          logger.warn({ err: idemErr, tenantId }, '[bookingService] idempotency pre-check failed — proceeding without dedup');
        } catch (_) {}
      }
    }

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

    // 5. PMS reservation create.
    //
    // Phase 63 P0-6: create it as PENDING_PAYMENT, not INQUIRY. The PMS
    // availability engine only counts CONFIRMED/OPTION (and now
    // PENDING_PAYMENT) as consuming inventory, so an INQUIRY row reduced
    // nothing — N concurrent guests could each hold the SAME last room for the
    // whole 15-minute payment window and all of them would be told it was
    // available. PENDING_PAYMENT existed in the reservation_status enum
    // (migration 0066) but no code ever wrote it.
    const pmsResult = await dispatch(
      cmds.create,
      Object.assign(mapInput(input, pricing), { initial_status: 'PENDING_PAYMENT' }),
      ctx
    );
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

    // 0. Phase 63 P0-3 — FAIL CLOSED before anything else.
    //
    // Every gate below used to be written as `if (paymentState && ...)`, so a
    // NULL payment state skipped all of them; `verifyResult` then defaulted to
    // {ok:true,status:'paid'} and the reservation was confirmed with zero
    // payment evidence. A missing state row is not "no opinion" — it is the
    // absence of proof, and absence of proof must reject.
    //
    // The un-wired case matters just as much: src/index.js builds the provider,
    // the state store and the attempt log inside ONE try/catch, so a single
    // provider misconfiguration silently drops all three and every confirm
    // would have sailed through.
    if (requirePayment) {
      if (!paymentStateStore || !paymentProvider) {
        return { ok: false, reason: 'payment_subsystem_unavailable',
                 detail: [{ store: Boolean(paymentStateStore), provider: Boolean(paymentProvider) }] };
      }
      if (!paymentId) {
        return { ok: false, reason: 'payment_reference_required' };
      }
    }

    // 1. Check payment state
    let paymentState = null;
    if (paymentStateStore) {
      paymentState = await paymentStateStore.getByReservationId(reservationId, ctx);
    }
    if (requirePayment && !paymentState) {
      return { ok: false, reason: 'payment_state_missing' };
    }
    if (paymentState && paymentState.payment_status !== 'pending_payment') {
      return { ok: false, reason: 'invalid_payment_state', detail: [{ state: paymentState.payment_status }] };
    }

    // 2. Check hold not expired
    if (requirePayment && paymentState && !paymentState.hold_expires_at) {
      // A pending_payment row with no expiry is an unbounded hold — reject
      // rather than let it be confirmed at any future time.
      return { ok: false, reason: 'payment_hold_missing_expiry' };
    }
    if (paymentState && paymentState.hold_expires_at) {
      if (new Date(paymentState.hold_expires_at).getTime() < Date.now()) {
        if (paymentStateStore) {
          await paymentStateStore.upsert({ reservation_id: reservationId, payment_status: 'failed', failed_at: new Date().toISOString() }, ctx).catch(() => {});
        }
        return { ok: false, reason: 'hold_expired' };
      }
    }

    // 3. Verify payment.
    // Phase 63 P0-3: the default is now UNVERIFIED, not "paid". Optimistic
    // success here meant that any path which skipped the provider call (no
    // provider wired, no paymentId supplied, provider threw) was read as a
    // successful payment.
    let verifyResult = requirePayment ? { ok: false, status: 'unverified' } : { ok: true, status: 'paid' };
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

    // 4b. Phase 63 P0-8 — CLAIM the hold atomically before touching the PMS.
    //
    // Previously confirm read the state, then (much later) wrote 'paid'. In the
    // gap the hold-expiry sweep could flip the same row to 'failed' and cancel
    // the reservation, so the guest was charged for a booking that had just
    // been cancelled. A compare-and-set out of 'pending_payment' makes exactly
    // one of {confirm, sweep} the winner.
    if (paymentStateStore && typeof paymentStateStore.transitionPending === 'function') {
      const claimed = await paymentStateStore.transitionPending(
        reservationId, 'paid',
        { paid_at: new Date().toISOString(), provider_ref: paymentId || null },
        ctx
      );
      if (!claimed && requirePayment) {
        // The sweep (or a concurrent confirm) already took this hold.
        return { ok: false, reason: 'payment_hold_lost' };
      }
    }

    // 5. PMS confirm (INQUIRY | PENDING_PAYMENT -> CONFIRMED)
    const pmsConfirm = await dispatch('pms.reservation.confirm', { reservation_id: reservationId }, ctx);
    if (!pmsConfirm || !pmsConfirm.ok) {
      // The payment is already captured and the hold is claimed. Do NOT roll the
      // state back to 'pending_payment' — that would re-open the sweep race.
      // Surface it loudly instead so it lands in operator reconciliation.
      try {
        require('../config/logger').error(
          { code: 'payment_captured_without_confirmation', tenantId, reservationId,
            pms_error: pmsConfirm && pmsConfirm.error },
          '[bookingService] payment captured but PMS confirm failed - MANUAL RECONCILIATION REQUIRED');
      } catch (_) { /* logging must never mask the result */ }
      emit('booking.payment_captured_without_confirmation', { tenantId, reservationId, reason: pmsConfirm && pmsConfirm.error });
      return {
        ok: false,
        reason: (pmsConfirm && pmsConfirm.error) || 'pms_confirm_failed',
        payment_captured: true,
        requires_reconciliation: true
      };
    }

    const confirmationNumber = (pmsConfirm.result && pmsConfirm.result.confirmation_number) || null;

    // 6. ARI inventory adjustment (ceiling-guarded in adjuster)
    if (adjuster && roomTypeId && arrival && departure) {
      try {
        await adjuster.adjustSold({ tenantId, propertyId, roomTypeId, arrival, departure, delta: +1 });
      } catch (_) {}
    }

    // 7. Update payment state.
    // With P0-8 the CAS in step 4b has already moved the row to 'paid'. This
    // upsert remains only for stores that predate transitionPending (it is a
    // no-op rewrite of the same values otherwise).
    if (paymentStateStore && typeof paymentStateStore.transitionPending !== 'function') {
      await paymentStateStore.upsert({
        reservation_id: reservationId,
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
        provider_ref: paymentId || null,
      }, ctx).catch(() => {});
    }

    emit('booking.created', { tenantId, channel: 'DIRECT', reservationId, action: 'confirmed_with_payment' });

    // 8. Queue confirmation delivery (non-blocking; failure must not abort the booking).
    let deliveryQueued = false;
    if (confirmationDeliveryService && ctx && ctx.guestRecipient) {
      try {
        const qr = await confirmationDeliveryService.queueDelivery({
          tenantId, propertyId, reservationId,
          confirmationNumber: confirmationNumber || null,
          channel:   ctx.guestChannel   || 'email',
          recipient: ctx.guestRecipient,
          context:   { reservation_id: reservationId, confirmation_number: confirmationNumber },
        }, ctx);
        deliveryQueued = qr.ok && !qr.deduped;
      } catch (_) { /* delivery queue failure is non-fatal */ }
    }

    return { ok: true, result: { reservation_id: reservationId, action: 'confirm', confirmation_number: confirmationNumber, delivery_queued: deliveryQueued } };
  }

  return { createBooking, updateBooking, cancelBooking, initiateBooking, confirmBooking };
}

module.exports = { buildBookingService };
