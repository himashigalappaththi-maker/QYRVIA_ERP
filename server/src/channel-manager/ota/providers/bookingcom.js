'use strict';

/**
 * Booking.com transport provider (Phase 30.2; re-aligned to Booking.com's
 * current official Connectivity contract in Phase 69A / instruction 048).
 *
 * Delivery itself is performed by the injected HTTP transport (default
 * DISABLED -> no live call, no certification claim).
 *
 * PHASE 69A CONTRACT ALIGNMENT — what changed and why
 * ────────────────────────────────────────────────────────────────────────
 * Instruction 048 found two protocol defects in the pre-existing codec, both
 * fixed HERE (rate/reservation ops are explicitly OUT of this phase's scope
 * per the instruction's own Section 15 and are UNCHANGED):
 *
 *   1. endpointFor() previously required an operator-supplied ctx.endpoint
 *      for EVERY op, including availability — but Booking.com documents
 *      exactly one Connectivity availability endpoint (there is no separate
 *      "sandbox hostname"; test vs. production is a property/credential
 *      distinction, never a URL distinction — see
 *      src/channel-manager/adapters/bookingcom/testPropertyGuard.js's own
 *      header for the full explanation). endpointFor() now defaults
 *      pushAvailability to that documented endpoint when no ctx.endpoint
 *      override is supplied. ctx.endpoint still always wins when present
 *      (test fixtures, future harnesses, activation config).
 *   2. encodeAvailability() previously returned a JSON object, which the
 *      shared HTTP transport would JSON.stringify — but Booking.com's
 *      documented availability endpoint
 *      (POST https://supply-xml.booking.com/hotels/xml/availability) is
 *      application/xml, not JSON. encodeAvailability() now returns a
 *      deterministic, escaped, validated B.XML request STRING (see
 *      buildAvailabilityXml() below) and headersFor() declares the matching
 *      Content-Type/Accept-Version. encodeRateUpdate()/encodeReservationAck()
 *      are UNCHANGED (still JSON) — rate support is explicitly not required
 *      to authorize the first sandbox operation (instruction 048 Section 15).
 *
 * UNVERIFIED ASSUMPTION, DISCLOSED (instruction 048 Section 12): the exact
 * element/attribute names inside buildAvailabilityXml()'s output are a
 * best-effort mapping onto Booking.com's publicly documented field
 * vocabulary (hotel_id, room_id, date, rooms_to_sell, closed — the SAME
 * field names the pre-Phase-69A JSON shape already used, chosen for
 * continuity/traceability) — this repository has no live network access to
 * fetch and diff against Booking.com's current B.XML XSD, so the exact tag
 * structure is NOT claimed to be byte-for-byte certified. This is exactly
 * the kind of assumption instruction 048 Section 12 requires sandbox proof
 * for, not fabrication of a false certainty. No provider call is made by
 * this module or anything that imports it in this phase.
 *
 * decodeAck() now branches on `op`: pushAvailability responses are decoded
 * as XML (Booking.com's documented format for this endpoint); every other
 * op keeps the pre-existing JSON-oriented decoding UNCHANGED.
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck, classifyHttpStatus } = require('./_shared');
const { escapeXmlText, escapeXmlAttr, extractXmlTagText, hasXmlTag } = require('../../adapters/bookingcom/xml');

// Booking.com Connectivity — Rates & Availability (B.XML), current
// documented endpoint. ONE endpoint for both TEST and PRODUCTION machine
// accounts; environment is a property/credential classification, never a
// hostname distinction (instruction 048 Section 13).
const AVAILABILITY_ENDPOINT = 'https://supply-xml.booking.com/hotels/xml/availability';
const AVAILABILITY_ACCEPT_VERSION = '1.1';

function restrictions(r = {}) {
  return {
    closed_to_arrival: !!r.cta,
    closed_to_departure: !!r.ctd,
    min_length_of_stay: r.min_los != null ? r.min_los : (r.minLos != null ? r.minLos : null),
    max_length_of_stay: r.max_los != null ? r.max_los : (r.maxLos != null ? r.maxLos : null)
  };
}

function ariXmlError(code, message) {
  const e = new Error(message);
  e.code = code;
  e.retryable = false; // a codec/validation defect never resolves itself by retrying the same input
  return e;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deterministic, escaped, validated B.XML availability request body. Fails
 * CLOSED (throws, never fabricates/defaults) on any missing or malformed
 * field — see instruction 048 Section 16. Every value that reaches the XML
 * text is passed through escapeXmlText/escapeXmlAttr, so no mapped
 * identifier can ever produce malformed XML via string interpolation.
 */
function buildAvailabilityXml(inv) {
  const hotelId = inv && (inv.hotelCode || inv.otaPropertyId);
  if (!hotelId || typeof hotelId !== 'string') {
    throw ariXmlError('BOOKING_COM_XML_MISSING_HOTEL_ID', 'availability XML requires a mapped hotel/property id');
  }
  const roomId = inv && (inv.otaRoomId || inv.roomTypeId);
  if (!roomId || typeof roomId !== 'string') {
    throw ariXmlError('BOOKING_COM_XML_MISSING_ROOM_ID', 'availability XML requires a mapped room id');
  }
  const date = inv && inv.date;
  if (typeof date !== 'string' || !ISO_DATE_RE.test(date)) {
    throw ariXmlError('BOOKING_COM_XML_INVALID_DATE', 'availability XML requires an ISO (YYYY-MM-DD) date');
  }
  const roomsToSell = inv && inv.available;
  if (!Number.isInteger(roomsToSell) || roomsToSell < 0) {
    throw ariXmlError('BOOKING_COM_XML_INVALID_QUANTITY', 'availability XML requires a non-negative integer rooms-to-sell quantity');
  }
  const closed = !!(inv && (inv.stop_sell || inv.stopSell));

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<request>\n' +
    '  <hotel_id>' + escapeXmlText(hotelId) + '</hotel_id>\n' +
    '  <availability>\n' +
    '    <room id="' + escapeXmlAttr(roomId) + '">\n' +
    '      <date value="' + escapeXmlAttr(date) + '">\n' +
    '        <rooms_to_sell>' + String(roomsToSell) + '</rooms_to_sell>\n' +
    '        <closed>' + (closed ? 'true' : 'false') + '</closed>\n' +
    '      </date>\n' +
    '    </room>\n' +
    '  </availability>\n' +
    '</request>\n'
  );
}

/**
 * XML-aware ack decoder for pushAvailability. Status code drives ok/retryable
 * classification (unchanged convention — classifyHttpStatus), body text is
 * used ONLY to opportunistically extract a Booking.com-supplied ack/RUID
 * identifier; a success is NEVER downgraded to failure for lacking one, and
 * an ack id is NEVER fabricated when absent (instruction 048 Section 22 —
 * QYRVIA's durable ledger may legitimately complete with provider_ack_id
 * null when success is proven by HTTP status alone).
 */
function decodeAvailabilityAckXml(raw) {
  raw = raw || {};
  if (raw.error === 'transport_disabled') {
    return { ok: false, status: 0, retryable: false, errors: [{ code: 'transport_disabled', message: 'OTA HTTP transport disabled' }], raw };
  }
  const status = raw.status || 0;
  const text = typeof raw.bodyText === 'string' ? raw.bodyText : null;
  if (raw.ok && status >= 200 && status < 300) {
    // Best-effort RUID/ack extraction — absence is not a failure.
    const ruid = text ? (extractXmlTagText(text, 'ruid') || extractXmlTagText(text, 'RUID')) : null;
    const okTag = text ? (hasXmlTag(text, 'ok') || hasXmlTag(text, 'Ok') || hasXmlTag(text, 'success')) : false;
    return { ok: true, ackId: ruid || null, status, errors: [], raw: Object.assign({}, raw, { xmlOkTagPresent: okTag }) };
  }
  const errMessage = text ? (extractXmlTagText(text, 'error') || extractXmlTagText(text, 'message')) : null;
  const errors = errMessage
    ? [{ code: 'booking_com_xml_error', message: errMessage }]
    : [{ code: 'http_' + status, message: raw.error || ('Booking.com error ' + status) }];
  return { ok: false, status, retryable: classifyHttpStatus(status), errors, raw };
}

const bookingcom = {
  channel: CHANNELS.BOOKING_COM,
  rateLimit: { minIntervalMs: 0 },                       // configurable per deployment

  endpointFor(op, ctx) {
    if (ctx && ctx.endpoint) return ctx.endpoint; // explicit override always wins
    if (op === 'pushAvailability') return AVAILABILITY_ENDPOINT; // documented default (Phase 69A)
    return null; // rate/reservation not endpoint-aligned in this phase — unchanged
  },

  /**
   * LEGACY synchronous auth mapping (api_key / username+password). Kept for
   * backward compatibility with any caller that resolves auth headers
   * synchronously from an already-resolved secret. The COMMERCIAL target for
   * new Booking.com connections is the token-based Bearer path — see
   * src/channel-manager/adapters/bookingcom/tokenProvider.js's
   * toAuthHeaders(), which src/ari/dispatch/ariChannelDispatcher.js uses
   * INSTEAD of this function whenever a bookingComTokenProvider dependency
   * is configured. This function is never itself upgraded to emit a Bearer
   * header — a token requires an async exchange this synchronous shape
   * cannot represent, and instruction 048 explicitly forbids silently
   * falling back to Basic when token exchange fails, so the two paths are
   * kept structurally separate rather than merged.
   */
  authToHeaders(secret) {
    if (!secret) return {};
    if (secret.api_key) return { 'X-Booking-Api-Key': secret.api_key };
    if (secret.username && secret.password) return { Authorization: 'Basic ' + Buffer.from(secret.username + ':' + secret.password).toString('base64') };
    return {};
  },

  /** Static, non-auth headers this op requires — merged in by ota/transport.js's deliver(). */
  headersFor(op) {
    if (op === 'pushAvailability') return { 'Content-Type': 'application/xml', 'Accept-Version': AVAILABILITY_ACCEPT_VERSION };
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

  /** Phase 69A: returns a B.XML request STRING (see buildAvailabilityXml header). */
  encodeAvailability(inv) {
    return buildAvailabilityXml(inv);
  },

  encodeReservationAck(res) {
    return { hotel_id: res.hotelCode || null, reservation_id: res.otaReservationId || res.reservationId || res.bookingId, status: res.status };
  },

  decodeAck(op, raw) {
    if (op === 'pushAvailability') return decodeAvailabilityAckXml(raw);
    return legacyJsonDecodeAck(op, raw);
  }
};

// Pre-existing JSON-oriented decoder, UNCHANGED, still used for every op
// other than pushAvailability (rate/reservation stay JSON in this phase).
const legacyJsonDecodeAck = buildDecodeAck({
  extractAckId: (raw) => raw.body && (raw.body.confirmation_id || raw.body.ack_id),
  mapErrors: (raw, status) => {
    const errs = raw.body && Array.isArray(raw.body.errors)
      ? raw.body.errors.map((e) => ({ code: String(e.code || e.id || 'error'), message: e.message || '' }))
      : [];
    return errs.length ? errs : [{ code: 'http_' + status, message: raw.error || ('Booking.com error ' + status) }];
  }
});

module.exports = { bookingcom, AVAILABILITY_ENDPOINT, AVAILABILITY_ACCEPT_VERSION, buildAvailabilityXml, decodeAvailabilityAckXml };
