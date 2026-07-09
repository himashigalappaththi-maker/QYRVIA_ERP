'use strict';

/**
 * Google Hotel Ads transport provider (Phase 50) — codec + auth mapping for
 * Google's Hotel Price API (ARI). Delivery via injected HTTP transport (DISABLED).
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck } = require('./_shared');

const google = {
  channel: CHANNELS.GOOGLE,
  rateLimit: { minIntervalMs: 0 },
  endpointFor(op, ctx) { return (ctx && ctx.endpoint) || null; },

  authToHeaders(secret) {
    if (!secret) return {};
    if (secret.access_token) return { 'Authorization': 'Bearer ' + secret.access_token };
    if (secret.token)        return { 'Authorization': 'Bearer ' + secret.token };
    if (secret.api_key)      return { 'X-Goog-Api-Key': secret.api_key };
    return {};
  },

  encodeRateUpdate(rate) {
    return {
      hotel_id:      rate.hotelCode || rate.otaPropertyId || null,
      room_type_id:  rate.otaRoomId || rate.roomTypeId,
      rate_plan_id:  rate.otaRatePlanId || rate.ratePlanId,
      itinerary: {
        checkin_date:  rate.date,
        los:           1,
        rate:          { value: rate.rate, currency: rate.currency || 'USD' }
      },
      restrictions: {
        min_advance_booking_offset: (rate.restrictions && rate.restrictions.minLos != null) ? rate.restrictions.minLos : null,
        closed_to_arrival:   !!(rate.restrictions && rate.restrictions.cta),
        closed_to_departure: !!(rate.restrictions && rate.restrictions.ctd)
      }
    };
  },

  encodeAvailability(inv) {
    return {
      hotel_id:     inv.hotelCode || inv.otaPropertyId || null,
      room_type_id: inv.otaRoomId || inv.roomTypeId,
      date:         inv.date,
      room_count:   inv.available,
      stop_sell:    !!(inv.stop_sell || inv.stopSell)
    };
  },

  encodeReservationAck(res) {
    return {
      hotel_id:       res.hotelCode || null,
      order_id:       res.otaReservationId || res.reservationId || res.bookingId,
      status:         res.status
    };
  },

  decodeAck: buildDecodeAck({
    extractAckId: (raw) => raw.body && (raw.body.order_id || raw.body.name),
    mapErrors: (raw, status) => {
      const body = raw.body || {};
      if (body.error && Array.isArray(body.error.errors)) {
        return body.error.errors.map((e) => ({ code: String(e.reason || 'error'), message: e.message || '' }));
      }
      return [{ code: 'http_' + status, message: raw.error || ('Google Hotel Ads error ' + status) }];
    }
  })
};

module.exports = { google };
