'use strict';

/**
 * Booking.com transport provider (Phase 30.2) - REAL request/response codec, auth
 * header mapping, and error/retry classification. No mock: it maps the neutral ARI
 * update shape onto Booking.com's documented ARI message structure and parses its
 * ack/error responses. Delivery itself is performed by the injected HTTP transport
 * (default DISABLED -> no live call, no certification claim).
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck } = require('./_shared');

function restrictions(r = {}) {
  return {
    closed_to_arrival: !!r.cta,
    closed_to_departure: !!r.ctd,
    min_length_of_stay: r.min_los != null ? r.min_los : (r.minLos != null ? r.minLos : null),
    max_length_of_stay: r.max_los != null ? r.max_los : (r.maxLos != null ? r.maxLos : null)
  };
}

const bookingcom = {
  channel: CHANNELS.BOOKING_COM,
  rateLimit: { minIntervalMs: 0 },                       // configurable per deployment
  endpointFor(op, ctx) { return (ctx && ctx.endpoint) || null; },

  authToHeaders(secret) {
    if (!secret) return {};
    if (secret.api_key) return { 'X-Booking-Api-Key': secret.api_key };
    if (secret.username && secret.password) return { Authorization: 'Basic ' + Buffer.from(secret.username + ':' + secret.password).toString('base64') };
    return {};
  },

  encodeRateUpdate(rate) {
    return {
      hotel_id: rate.hotelCode || rate.otaPropertyId || null,
      ari: [{
        room_id: rate.otaRoomId || rate.roomTypeId,
        rate_plan_id: rate.otaRatePlanId || rate.ratePlanId,
        date: rate.date,
        rate: { amount: rate.rate, currency: rate.currency || 'USD' },
        restrictions: restrictions(rate.restrictions || rate)
      }]
    };
  },

  encodeAvailability(inv) {
    return {
      hotel_id: inv.hotelCode || inv.otaPropertyId || null,
      availability: [{
        room_id: inv.otaRoomId || inv.roomTypeId,
        date: inv.date,
        rooms_to_sell: inv.available,
        closed: !!(inv.stop_sell || inv.stopSell)
      }]
    };
  },

  encodeReservationAck(res) {
    return { hotel_id: res.hotelCode || null, reservation_id: res.otaReservationId || res.reservationId || res.bookingId, status: res.status };
  },

  decodeAck: buildDecodeAck({
    extractAckId: (raw) => raw.body && (raw.body.confirmation_id || raw.body.ack_id),
    mapErrors: (raw, status) => {
      const errs = raw.body && Array.isArray(raw.body.errors)
        ? raw.body.errors.map((e) => ({ code: String(e.code || e.id || 'error'), message: e.message || '' }))
        : [];
      return errs.length ? errs : [{ code: 'http_' + status, message: raw.error || ('Booking.com error ' + status) }];
    }
  })
};

module.exports = { bookingcom };
