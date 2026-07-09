'use strict';

/**
 * TripAdvisor transport provider (Phase 50) — codec + auth mapping for
 * TripAdvisor's Connectivity API. Delivery via injected HTTP transport (DISABLED).
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck } = require('./_shared');

const tripadvisor = {
  channel: CHANNELS.TRIPADVISOR,
  rateLimit: { minIntervalMs: 0 },
  endpointFor(op, ctx) { return (ctx && ctx.endpoint) || null; },

  authToHeaders(secret) {
    if (!secret) return {};
    if (secret.api_key) return { 'X-TripAdvisor-API-Key': secret.api_key };
    if (secret.token)   return { 'Authorization': 'Bearer ' + secret.token };
    return {};
  },

  encodeRateUpdate(rate) {
    return {
      property_id:  rate.hotelCode || rate.otaPropertyId || null,
      room_id:      rate.otaRoomId || rate.roomTypeId,
      rate_plan_id: rate.otaRatePlanId || rate.ratePlanId,
      dates: [{
        date:     rate.date,
        rate:     { amount: rate.rate, currency: rate.currency || 'USD' },
        min_los:  (rate.restrictions && rate.restrictions.minLos != null) ? rate.restrictions.minLos : null,
        max_los:  (rate.restrictions && rate.restrictions.maxLos != null) ? rate.restrictions.maxLos : null,
        cta:      !!(rate.restrictions && rate.restrictions.cta),
        ctd:      !!(rate.restrictions && rate.restrictions.ctd)
      }]
    };
  },

  encodeAvailability(inv) {
    return {
      property_id:  inv.hotelCode || inv.otaPropertyId || null,
      room_id:      inv.otaRoomId || inv.roomTypeId,
      dates: [{
        date:       inv.date,
        rooms:      inv.available,
        stop_sell:  !!(inv.stop_sell || inv.stopSell)
      }]
    };
  },

  encodeReservationAck(res) {
    return {
      property_id:    res.hotelCode || null,
      reservation_id: res.otaReservationId || res.reservationId || res.bookingId,
      status:         res.status
    };
  },

  decodeAck: buildDecodeAck({
    extractAckId: (raw) => raw.body && (raw.body.reservation_id || raw.body.confirmation_number),
    mapErrors: (raw, status) => {
      const errs = raw.body && Array.isArray(raw.body.errors)
        ? raw.body.errors.map((e) => ({ code: String(e.code || 'error'), message: e.message || '' }))
        : [];
      return errs.length ? errs : [{ code: 'http_' + status, message: raw.error || ('TripAdvisor error ' + status) }];
    }
  })
};

module.exports = { tripadvisor };
