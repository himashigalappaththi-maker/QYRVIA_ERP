'use strict';

/**
 * MakeMyTrip transport provider (Phase 50) — codec + auth mapping for MMT's
 * Connectivity API. Delivery via the injected HTTP transport (default DISABLED).
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck } = require('./_shared');

const makemytrip = {
  channel: CHANNELS.MAKEMYTRIP,
  rateLimit: { minIntervalMs: 0 },
  endpointFor(op, ctx) { return (ctx && ctx.endpoint) || null; },

  authToHeaders(secret) {
    if (!secret) return {};
    if (secret.api_key && secret.api_secret) {
      return {
        'X-MMT-API-Key':    secret.api_key,
        'X-MMT-API-Secret': secret.api_secret
      };
    }
    if (secret.api_key) return { 'X-MMT-API-Key': secret.api_key };
    if (secret.token)   return { 'Authorization': 'Bearer ' + secret.token };
    return {};
  },

  encodeRateUpdate(rate) {
    return {
      hotel_code:    rate.hotelCode || rate.otaPropertyId || null,
      room_type_code: rate.otaRoomId || rate.roomTypeId,
      rate_plan_code: rate.otaRatePlanId || rate.ratePlanId,
      dates: [{
        date:     rate.date,
        rate:     rate.rate,
        currency: rate.currency || 'INR',
        min_los:  (rate.restrictions && rate.restrictions.minLos != null) ? rate.restrictions.minLos : null,
        max_los:  (rate.restrictions && rate.restrictions.maxLos != null) ? rate.restrictions.maxLos : null,
        cta:      !!(rate.restrictions && rate.restrictions.cta),
        ctd:      !!(rate.restrictions && rate.restrictions.ctd)
      }]
    };
  },

  encodeAvailability(inv) {
    return {
      hotel_code:     inv.hotelCode || inv.otaPropertyId || null,
      room_type_code: inv.otaRoomId || inv.roomTypeId,
      dates: [{
        date:       inv.date,
        available:  inv.available,
        stop_sell:  !!(inv.stop_sell || inv.stopSell)
      }]
    };
  },

  encodeReservationAck(res) {
    return {
      hotel_code:      res.hotelCode || null,
      booking_ref:     res.otaReservationId || res.reservationId || res.bookingId,
      status:          res.status
    };
  },

  decodeAck: buildDecodeAck({
    extractAckId: (raw) => raw.body && (raw.body.booking_ref || raw.body.transaction_id),
    mapErrors: (raw, status) => {
      const errs = raw.body && Array.isArray(raw.body.errors)
        ? raw.body.errors.map((e) => ({ code: String(e.error_code || e.code || 'error'), message: e.error_message || e.message || '' }))
        : [];
      return errs.length ? errs : [{ code: 'http_' + status, message: raw.error || ('MakeMyTrip error ' + status) }];
    }
  })
};

module.exports = { makemytrip };
