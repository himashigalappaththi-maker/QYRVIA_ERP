'use strict';

/**
 * Agoda transport provider (Phase 50) — codec + auth mapping for Agoda's
 * YCS/ARI API. Delivery via the injected HTTP transport (default DISABLED).
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck } = require('./_shared');

const agoda = {
  channel: CHANNELS.AGODA,
  rateLimit: { minIntervalMs: 0 },
  endpointFor(op, ctx) { return (ctx && ctx.endpoint) || null; },

  authToHeaders(secret) {
    if (!secret) return {};
    if (secret.api_key) return { 'Authorization': 'Token ' + secret.api_key };
    if (secret.token)   return { 'Authorization': 'Bearer ' + secret.token };
    return {};
  },

  encodeRateUpdate(rate) {
    return {
      hotel_id: rate.hotelCode || rate.otaPropertyId || null,
      room_type_id: rate.otaRoomId || rate.roomTypeId,
      rate_plan_id: rate.otaRatePlanId || rate.ratePlanId,
      date: rate.date,
      sell_rate: rate.rate,
      currency: rate.currency || 'USD',
      min_stay: (rate.restrictions && rate.restrictions.minLos != null) ? rate.restrictions.minLos : null,
      max_stay: (rate.restrictions && rate.restrictions.maxLos != null) ? rate.restrictions.maxLos : null,
      closed_to_arrival:   !!(rate.restrictions && rate.restrictions.cta),
      closed_to_departure: !!(rate.restrictions && rate.restrictions.ctd)
    };
  },

  encodeAvailability(inv) {
    return {
      hotel_id:    inv.hotelCode || inv.otaPropertyId || null,
      room_type_id: inv.otaRoomId || inv.roomTypeId,
      date:         inv.date,
      allotment:    inv.available,
      stop_sell:    !!(inv.stop_sell || inv.stopSell)
    };
  },

  encodeReservationAck(res) {
    return {
      hotel_id:       res.hotelCode || null,
      booking_id:     res.otaReservationId || res.reservationId || res.bookingId,
      status:         res.status
    };
  },

  decodeAck: buildDecodeAck({
    extractAckId: (raw) => raw.body && (raw.body.booking_id || raw.body.ack_id),
    mapErrors: (raw, status) => {
      const errs = raw.body && Array.isArray(raw.body.errors)
        ? raw.body.errors.map((e) => ({ code: String(e.code || 'error'), message: e.message || '' }))
        : [];
      return errs.length ? errs : [{ code: 'http_' + status, message: raw.error || ('Agoda error ' + status) }];
    }
  })
};

module.exports = { agoda };
