'use strict';

/**
 * Airbnb transport provider (Phase 50) — codec + auth mapping for Airbnb's
 * Listing API. Delivery via the injected HTTP transport (default DISABLED).
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck } = require('./_shared');

const airbnb = {
  channel: CHANNELS.AIRBNB,
  rateLimit: { minIntervalMs: 0 },
  endpointFor(op, ctx) { return (ctx && ctx.endpoint) || null; },

  authToHeaders(secret) {
    if (!secret) return {};
    if (secret.access_token) return { 'Authorization': 'Bearer ' + secret.access_token };
    if (secret.token)        return { 'Authorization': 'Bearer ' + secret.token };
    if (secret.api_key)      return { 'X-Airbnb-API-Key': secret.api_key };
    return {};
  },

  encodeRateUpdate(rate) {
    return {
      listing_id:  rate.otaPropertyId || rate.hotelCode || null,
      pricing_rules: [{
        date:          rate.date,
        price:         rate.rate,
        currency:      rate.currency || 'USD',
        min_nights:    (rate.restrictions && rate.restrictions.minLos != null) ? rate.restrictions.minLos : null,
        max_nights:    (rate.restrictions && rate.restrictions.maxLos != null) ? rate.restrictions.maxLos : null
      }]
    };
  },

  encodeAvailability(inv) {
    return {
      listing_id:    inv.otaPropertyId || inv.hotelCode || null,
      calendar: [{
        date:         inv.date,
        available:    inv.available > 0 && !(inv.stop_sell || inv.stopSell),
        available_count: inv.available
      }]
    };
  },

  encodeReservationAck(res) {
    return {
      listing_id:      res.otaPropertyId || res.hotelCode || null,
      reservation_id:  res.otaReservationId || res.reservationId || res.bookingId,
      status:          res.status
    };
  },

  decodeAck: buildDecodeAck({
    extractAckId: (raw) => raw.body && (raw.body.reservation_id || raw.body.id),
    mapErrors: (raw, status) => {
      const errs = raw.body && Array.isArray(raw.body.errors)
        ? raw.body.errors.map((e) => ({ code: String(e.code || e.type || 'error'), message: e.message || '' }))
        : [];
      return errs.length ? errs : [{ code: 'http_' + status, message: raw.error || ('Airbnb error ' + status) }];
    }
  })
};

module.exports = { airbnb };
