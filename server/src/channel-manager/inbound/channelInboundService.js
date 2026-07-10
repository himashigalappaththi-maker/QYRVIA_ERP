'use strict';

/**
 * channelInboundService (Phase 24 B8-B4) - turns a canonical OTA booking into a
 * PMS reservation, idempotently and via the kernel command bus ONLY (no direct
 * PMS code change):
 *   1. status-rank monotonicity (stale/duplicate => no-op; cancel-after-presence => exception)
 *   2. booking_store upsert (idempotent by tenant+channel+external_ref)
 *   3. commandBus.dispatch(create|update) with the external_ref correlation
 *   4. link pms_reservation_id back onto booking_store
 *
 * On command failure the booking is retained as link-pending (no duplicate on retry).
 */

const STATUS_RANK = Object.freeze({ PENDING: 1, CONFIRMED: 2, CHECKED_IN: 3, CHECKED_OUT: 4, CANCELLED: 99 });
const rank = (s) => (STATUS_RANK[s] != null ? STATUS_RANK[s] : 0);

function buildChannelInboundService({ bookingStore, commandBus, commandMap, toReservationInput, onAudit, availabilityProvider = null, channelRegistry = null, importLog = null } = {}) {
  if (!bookingStore) throw new Error('channelInboundService: bookingStore required');
  if (!commandBus) throw new Error('channelInboundService: commandBus required');

  const cmds = Object.assign({ create: 'pms.reservation.create', update: 'pms.reservation.update', cancel: 'pms.reservation.update' }, commandMap || {});
  const mapInput = toReservationInput || ((b) => ({
    external_ref: b.externalRef || b.bookingId, room_type_id: b.roomTypeId || null,
    arrival_date: b.arrival || null, departure_date: b.departure || null, guest_name: b.guestName || null,
    amount: b.amount != null ? b.amount : null, currency: b.currency || null, source_channel: b.channel, status: b.status
  }));
  function emitAudit(type, meta) { if (typeof onAudit === 'function') { try { onAudit(Object.assign({ type }, meta)); } catch (_) { /* never throws */ } } }

  // Phase 53 Fix 3: write import log after each ingest outcome; never blocks ingest.
  async function writeImportLog({ tenantId, propertyId, channel, external_booking_id, outcome, error_message }) {
    if (!importLog) return;
    try {
      await importLog.insert({
        tenant_id: tenantId,
        property_id: propertyId || null,
        channel_code: channel,
        external_booking_id: external_booking_id || null,
        outcome,
        error_message: error_message || null,
      });
    } catch (_) { /* never block ingest */ }
  }

  async function ingest(booking, { ctx } = {}) {
    if (!booking || !booking.bookingId || !booking.channel || !booking.status) {
      await writeImportLog({ tenantId: (ctx && ctx.tenantId) || null, propertyId: null, channel: booking && booking.channel, external_booking_id: booking && (booking.externalRef || booking.bookingId), outcome: 'rejected', error_message: 'invalid_booking' });
      return { ok: false, error: 'invalid_booking' };
    }
    if (!ctx || !ctx.tenantId) {
      await writeImportLog({ tenantId: null, propertyId: null, channel: booking.channel, external_booking_id: booking.externalRef || booking.bookingId, outcome: 'rejected', error_message: 'tenant_required' });
      return { ok: false, error: 'tenant_required' };
    }

    const tenant_id = ctx.tenantId;
    const property_id = ctx.propertyId || null;
    const channel = booking.channel;
    const external_ref = booking.externalRef || booking.bookingId;

    try {
      // H2: Kill-switch — if registry is injected, block disabled channels before any other logic
      if (channelRegistry) {
        const reg = await channelRegistry.get(channel, ctx).catch(() => null);
        if (reg && !reg.enabled) {
          await writeImportLog({ tenantId: tenant_id, propertyId: property_id, channel, external_booking_id: external_ref, outcome: 'rejected', error_message: 'channel_disabled' });
          return { ok: false, error: 'channel_disabled' };
        }
      }

      const existing = await Promise.resolve(bookingStore.getByExternalRef(tenant_id, channel, external_ref, property_id));

      // cancel after physical presence -> exception, never mutate
      if (booking.status === 'CANCELLED' && existing && (existing.status === 'CHECKED_IN' || existing.status === 'CHECKED_OUT')) {
        emitAudit('channel.booking_cancel_rejected', { tenant_id, channel, external_ref, existing_status: existing.status });
        await writeImportLog({ tenantId: tenant_id, propertyId: property_id, channel, external_booking_id: external_ref, outcome: 'rejected', error_message: 'cannot_cancel_present' });
        return { ok: false, error: 'cannot_cancel_present', exception: true };
      }
      // monotonicity: equal/lower rank is stale or a duplicate -> no-op
      if (existing && rank(booking.status) <= rank(existing.status)) {
        await writeImportLog({ tenantId: tenant_id, propertyId: property_id, channel, external_booking_id: external_ref, outcome: 'deduped' });
        return { ok: true, deduped: true, booking: existing };
      }

      // H1: Availability gate — if provider is injected, check before accepting
      if (availabilityProvider) {
        const avail = await availabilityProvider({
          tenantId: ctx.tenantId,
          propertyId: ctx.propertyId,
          roomTypeId: booking.room_type_id || booking.roomTypeId,
          arrival: booking.arrival,
          departure: booking.departure,
          adults: booking.adults || 1,
          channel: booking.channel
        }).catch(() => 0);
        if (!avail || avail <= 0) {
          await bookingStore.upsert({
            ...booking,
            tenant_id: ctx.tenantId,
            property_id: ctx.propertyId || null,
            channel: booking.channel,
            external_ref: booking.externalRef || booking.bookingId,
            status: 'CONFLICT',
            conflict_reason: 'no_availability',
          }, ctx);
          await writeImportLog({ tenantId: tenant_id, propertyId: property_id, channel, external_booking_id: external_ref, outcome: 'rejected', error_message: 'no_availability' });
          return { ok: false, error: 'no_availability', status: 'CONFLICT' };
        }
      }

      const up = await Promise.resolve(bookingStore.upsert({
        tenant_id, property_id: ctx.propertyId || null, channel, external_ref, status: booking.status,
        guest_name: booking.guestName || null, arrival: booking.arrival || null, departure: booking.departure || null,
        room_type_id: booking.roomTypeId || null, amount: booking.amount != null ? booking.amount : null,
        currency: booking.currency || null, source_channel: channel
      }));
      const row = up.item;

      let action = row.pms_reservation_id ? 'update' : 'create';
      if (booking.status === 'CANCELLED') action = 'cancel';
      const input = mapInput(booking);
      if (row.pms_reservation_id) input.reservation_id = row.pms_reservation_id;

      let dispatch;
      try { dispatch = await commandBus.dispatch(cmds[action], input, ctx); }
      catch (e) { dispatch = { ok: false, error: String((e && e.message) || e) }; }

      if (!dispatch || !dispatch.ok) {
        emitAudit('channel.booking_link_pending', { tenant_id, channel, external_ref, action, error: dispatch && dispatch.error });
        return { ok: false, error: (dispatch && dispatch.error) || 'pms_dispatch_failed', booking: row, action, link_pending: true };
      }
      const resId = (dispatch.result && (dispatch.result.id || dispatch.result.reservation_id)) || dispatch.id || row.pms_reservation_id || null;
      if (resId && !row.pms_reservation_id) await Promise.resolve(bookingStore.setPmsReservationId(row.id, resId));
      emitAudit('channel.booking_ingested', { tenant_id, channel, external_ref, action, pms_reservation_id: resId, status: booking.status });
      await writeImportLog({ tenantId: tenant_id, propertyId: property_id, channel, external_booking_id: external_ref, outcome: 'accepted' });
      return { ok: true, action, booking: row, pms_reservation_id: resId };

    } catch (err) {
      await writeImportLog({ tenantId: tenant_id, propertyId: property_id, channel, external_booking_id: external_ref, outcome: 'error', error_message: String(err).slice(0, 500) });
      throw err;
    }
  }

  return { ingest, STATUS_RANK };
}

module.exports = { buildChannelInboundService, STATUS_RANK };
