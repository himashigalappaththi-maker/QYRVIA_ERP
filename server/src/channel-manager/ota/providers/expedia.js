'use strict';

/**
 * Expedia transport provider (Phase 30.2) - REAL codec on the SAME transport
 * architecture as Booking.com, mapping the neutral ARI update onto an Expedia
 * (EQC-style) Availability/Rates message and parsing its ack/errors. Auth is a
 * bearer token. Delivery via the injected HTTP transport (default DISABLED).
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck } = require('./_shared');

function r(v, a, b) { return v != null ? v : (a != null ? a : b); }

const expedia = {
  channel: CHANNELS.EXPEDIA,
  rateLimit: { minIntervalMs: 0 },
  endpointFor(op, ctx) { return (ctx && ctx.endpoint) || null; },

  authToHeaders(secret) {
    if (!secret) return {};
    if (secret.token) return { Authorization: 'Bearer ' + secret.token };
    if (secret.api_key) return { Key: secret.api_key };
    return {};
  },

  encodeRateUpdate(rate) {
    const rest = rate.restrictions || rate;
    return {
      resort_id: rate.hotelCode || rate.otaPropertyId || null,
      roomTypes: [{
        id: rate.otaRoomId || rate.roomTypeId,
        ratePlans: [{
          id: rate.otaRatePlanId || rate.ratePlanId,
          schedule: [{
            date: rate.date, rate: rate.rate, currency: rate.currency || 'USD',
            cta: !!rest.cta, ctd: !!rest.ctd,
            minStay: r(rest.min_los, rest.minLos, null), maxStay: r(rest.max_los, rest.maxLos, null)
          }]
        }]
      }]
    };
  },

  encodeAvailability(inv) {
    return {
      resort_id: inv.hotelCode || inv.otaPropertyId || null,
      roomTypes: [{ id: inv.otaRoomId || inv.roomTypeId, availability: [{ date: inv.date, inventory: inv.available, closed: !!(inv.stop_sell || inv.stopSell) }] }]
    };
  },

  encodeReservationAck(res) {
    return { resort_id: res.hotelCode || null, itinerary_id: res.otaReservationId || res.reservationId || res.bookingId, confirmation: res.status };
  },

  decodeAck: buildDecodeAck({
    extractAckId: (raw) => raw.body && (raw.body.transaction_id || raw.body.confirmation_id),
    mapErrors: (raw, status) => {
      const errs = raw.body && Array.isArray(raw.body.Errors || raw.body.errors)
        ? (raw.body.Errors || raw.body.errors).map((e) => ({ code: String(e.Code || e.code || 'error'), message: e.Message || e.message || '' }))
        : [];
      return errs.length ? errs : [{ code: 'http_' + status, message: raw.error || ('Expedia error ' + status) }];
    }
  })
};

module.exports = { expedia };
