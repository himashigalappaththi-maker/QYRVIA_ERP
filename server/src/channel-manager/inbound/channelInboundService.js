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

function buildChannelInboundService({ bookingStore, commandBus, commandMap, toReservationInput, onAudit } = {}) {
  if (!bookingStore) throw new Error('channelInboundService: bookingStore required');
  if (!commandBus) throw new Error('channelInboundService: commandBus required');

  const cmds = Object.assign({ create: 'pms.reservation.create', update: 'pms.reservation.update', cancel: 'pms.reservation.update' }, commandMap || {});
  const mapInput = toReservationInput || ((b) => ({
    external_ref: b.externalRef || b.bookingId, room_type_id: b.roomTypeId || null,
    arrival_date: b.arrival || null, departure_date: b.departure || null, guest_name: b.guestName || null,
    amount: b.amount != null ? b.amount : null, currency: b.currency || null, source_channel: b.channel, status: b.status
  }));
  function emitAudit(type, meta) { if (typeof onAudit === 'function') { try { onAudit(Object.assign({ type }, meta)); } catch (_) { /* never throws */ } } }

  async function ingest(booking, { ctx } = {}) {
    if (!booking || !booking.bookingId || !booking.channel || !booking.status) return { ok: false, error: 'invalid_booking' };
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };
    const tenant_id = ctx.tenantId;
    const channel = booking.channel;
    const external_ref = booking.externalRef || booking.bookingId;
    const existing = await Promise.resolve(bookingStore.getByExternalRef(tenant_id, channel, external_ref));

    // cancel after physical presence -> exception, never mutate
    if (booking.status === 'CANCELLED' && existing && (existing.status === 'CHECKED_IN' || existing.status === 'CHECKED_OUT')) {
      emitAudit('channel.booking_cancel_rejected', { tenant_id, channel, external_ref, existing_status: existing.status });
      return { ok: false, error: 'cannot_cancel_present', exception: true };
    }
    // monotonicity: equal/lower rank is stale or a duplicate -> no-op
    if (existing && rank(booking.status) <= rank(existing.status)) {
      return { ok: true, deduped: true, booking: existing };
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
    return { ok: true, action, booking: row, pms_reservation_id: resId };
  }

  return { ingest, STATUS_RANK };
}

module.exports = { buildChannelInboundService, STATUS_RANK };
