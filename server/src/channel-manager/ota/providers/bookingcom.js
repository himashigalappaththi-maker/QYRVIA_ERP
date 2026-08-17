'use strict';

/**
 * Booking.com transport provider (Phase 30.2; re-aligned to Booking.com's
 * official Connectivity contract in Phase 69A — instruction 048, hardened
 * further in instruction 049 against the exact current B.XML Availability
 * documentation).
 *
 * Delivery itself is performed by the injected HTTP transport (default
 * DISABLED -> no live call, no certification claim).
 *
 * PHASE 69A / INSTRUCTION 049 — B.XML CONTRACT HARDENING
 * ────────────────────────────────────────────────────────────────────────
 * Instruction 048 disclosed its own XML element names as a best-effort,
 * UNVERIFIED assumption. Instruction 049 corrects the request/response
 * contract against Booking.com's actual documented B.XML Availability
 * shape (rate/reservation ops remain OUT of scope, unchanged, still JSON):
 *
 *   1. NO <hotel_id> (or any property element) in the request body. The
 *      documented Availability payload is room-level only; QYRVIA's
 *      internal ota_property_id mapping remains REQUIRED for tenant/
 *      property association, TEST-property classification, and
 *      credential/property authorization — it is simply never serialized
 *      into this specific provider payload merely because QYRVIA stores it.
 *   2. Root is <request> directly containing <room id="INTEGER">, never a
 *      wrapping <availability> element.
 *   3. The quantity element is <roomstosell> (one word, Booking.com's own
 *      spelling), not <rooms_to_sell>.
 *   4. <closed> is normalized to the literal characters 0 or 1 — never
 *      true/false/"true"/"false".
 *   5. Room id is validated as a genuine Booking.com integer identifier
 *      (positive, no leading zero, safe integer) — a free-text OTA room
 *      code is REJECTED, not merely escaped-and-accepted.
 *   6. roomstosell is bounded to the safe initial range [0, 254] — 255 is
 *      Booking.com's documented "unlimited inventory" sentinel and is
 *      deliberately excluded this phase to prevent an accidental
 *      quantity/config error from silently opening unlimited inventory.
 *   7. Dates are validated as genuine CALENDAR dates (rejects 2026-02-30),
 *      not merely regex-shaped strings.
 *   8. decodeAck no longer treats HTTP 2xx as automatic success — Booking.com
 *      documents that a 2xx response MAY carry a Booking.com <errors>
 *      collection when part of a request failed; for this phase's
 *      single-update requests, ANY <errors> element (at any HTTP status)
 *      is treated as failure. <warnings> alone (no <errors>) remains a
 *      success, per Booking.com's own "warnings do not prevent processing"
 *      documentation.
 *   9. RUID is now extracted from its DOCUMENTED response-comment shape,
 *      <!-- RUID: [VALUE] --> (instruction 048's element-only <ruid>/<RUID>
 *      lookup was insufficient) — kept as a compatibility fallback only.
 */

const { CHANNELS } = require('../../core/canonical/types');
const { buildDecodeAck, classifyHttpStatus } = require('./_shared');
const { escapeXmlAttr, extractXmlTagText, hasXmlTag, extractRuidComment } = require('../../adapters/bookingcom/xml');

// Booking.com Connectivity — Rates & Availability (B.XML), current
// documented endpoint. ONE endpoint for both TEST and PRODUCTION machine
// accounts; environment is a property/credential classification, never a
// hostname distinction (instruction 048 Section 13).
const AVAILABILITY_ENDPOINT = 'https://supply-xml.booking.com/hotels/xml/availability';
const AVAILABILITY_ACCEPT_VERSION = '1.1';

// 255 is Booking.com's documented "unlimited inventory" sentinel — excluded
// from this phase's safe initial scope (instruction 049 Section 7).
const MAX_ROOMS_TO_SELL = 254;

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
// Booking.com room id: a genuine positive integer identifier — no leading
// zero (which would make "01" ambiguous with "1"), no sign, no decimal.
const BOOKING_COM_ROOM_ID_RE = /^[1-9]\d*$/;

function isValidBookingComRoomId(v) {
  if (typeof v !== 'string' || !BOOKING_COM_ROOM_ID_RE.test(v)) return false;
  return Number.isSafeInteger(Number(v));
}

/** True only for a REAL calendar date, not merely a regex-shaped string (rejects e.g. 2026-02-30). */
function isValidCalendarDate(str) {
  if (typeof str !== 'string' || !ISO_DATE_RE.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Deterministic, escaped, validated B.XML availability request body. Fails
 * CLOSED (throws, never fabricates/defaults) on any missing or malformed
 * field. Every value that reaches the XML text is passed through
 * escapeXmlAttr, so no mapped identifier can ever produce malformed XML via
 * string interpolation — though room id/date/quantity are all validated to
 * a known-safe character set BEFORE that point anyway (defense in depth).
 */
function buildAvailabilityXml(inv) {
  const roomId = inv && (inv.otaRoomId || inv.roomTypeId);
  if (typeof roomId !== 'string' || !isValidBookingComRoomId(roomId)) {
    throw ariXmlError(
      'BOOKING_COM_XML_INVALID_ROOM_ID',
      'Booking.com room id must be a positive integer string (missing/empty/non-numeric/non-integer/zero/negative/unsafe values are rejected) — a free-text OTA room code is never accepted for this provider'
    );
  }
  const date = inv && inv.date;
  if (!isValidCalendarDate(date)) {
    throw ariXmlError('BOOKING_COM_XML_INVALID_DATE', 'availability XML requires a real ISO (YYYY-MM-DD) calendar date — not merely a regex-shaped string');
  }
  const roomsToSell = inv && inv.available;
  if (typeof roomsToSell !== 'number' || !Number.isFinite(roomsToSell) || !Number.isInteger(roomsToSell) || roomsToSell < 0 || roomsToSell > MAX_ROOMS_TO_SELL) {
    throw ariXmlError(
      'BOOKING_COM_XML_INVALID_QUANTITY',
      'availability XML requires an integer roomstosell quantity in [0,' + MAX_ROOMS_TO_SELL + '] — 255 (Booking.com\'s documented unlimited-inventory sentinel) is deliberately excluded this phase, and negative/fractional/NaN/Infinity values are rejected'
    );
  }
  // QYRVIA business rule producing `closed`: derived from the SAME
  // pre-existing stop_sell/stopSell flag ariRateMapping.js's
  // mapInventoryChanged already computes from authoritative PMS inventory —
  // only the WIRE ENCODING changes here (0/1 per Booking.com's documented
  // contract, instead of true/false). No new commercial assumption.
  const closed = (inv && (inv.stop_sell || inv.stopSell)) ? 1 : 0;

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<request>\n' +
    '  <room id="' + escapeXmlAttr(roomId) + '">\n' +
    '    <date value="' + escapeXmlAttr(date) + '">\n' +
    '      <roomstosell>' + String(roomsToSell) + '</roomstosell>\n' +
    '      <closed>' + closed + '</closed>\n' +
    '    </date>\n' +
    '  </room>\n' +
    '</request>\n'
  );
}

/** Bounded, capped extraction of Booking.com <error code="..."><message>...</message></error> elements. */
function extractBookingComErrors(text, maxErrors = 10, maxFieldLen = 500) {
  const errors = [];
  if (typeof text !== 'string' || !text) return errors;
  const errorRe = /<error\b([^>]*)>([\s\S]*?)<\/error>/gi;
  let m;
  while ((m = errorRe.exec(text)) && errors.length < maxErrors) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const codeAttr = attrs.match(/\bcode\s*=\s*"([^"]*)"/i);
    const code = (codeAttr && codeAttr[1]) || extractXmlTagText(inner, 'code') || 'unknown';
    const message = extractXmlTagText(inner, 'message') || inner.replace(/<[^>]*>/g, '').trim();
    errors.push({ code: String(code).slice(0, 120), message: String(message).slice(0, maxFieldLen) });
  }
  return errors;
}

/** Bounded, capped extraction of Booking.com <warning code="..."><message>...</message></warning> elements. */
function extractBookingComWarnings(text, maxWarnings = 10, maxFieldLen = 500) {
  const warnings = [];
  if (typeof text !== 'string' || !text || !hasXmlTag(text, 'warnings')) return warnings;
  const warnRe = /<warning\b([^>]*)>([\s\S]*?)<\/warning>/gi;
  let m;
  while ((m = warnRe.exec(text)) && warnings.length < maxWarnings) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const codeAttr = attrs.match(/\bcode\s*=\s*"([^"]*)"/i);
    const code = (codeAttr && codeAttr[1]) || extractXmlTagText(inner, 'code') || 'unknown';
    const message = extractXmlTagText(inner, 'message') || inner.replace(/<[^>]*>/g, '').trim();
    warnings.push({ code: String(code).slice(0, 120), message: String(message).slice(0, maxFieldLen) });
  }
  return warnings;
}

/** Comment format (documented, primary) with element-form fallback (compatibility only). */
function extractRuid(text) {
  return extractRuidComment(text) || extractXmlTagText(text, 'ruid') || extractXmlTagText(text, 'RUID') || null;
}

/**
 * XML-aware ack decoder for pushAvailability (instruction 049 Section 11-14).
 *
 * SUCCESS requires ALL of:
 *   - HTTP 2xx, AND
 *   - no Booking.com <errors> collection present in the response body
 *     (regardless of HTTP status — Booking.com documents that a 2xx MAY
 *     still carry <errors> for a partially-failed request; for this
 *     phase's single-update requests, ANY <errors> is treated as a full
 *     failure rather than pretending partial success).
 * <warnings> alone (no <errors>) remains a SUCCESS — Booking.com documents
 * warnings do not prevent processing. Warning metadata is returned as
 * bounded, non-secret diagnostic data on the ack object only — no schema
 * change, no durable persistence (deferred; see instruction 049 Section 15).
 * A provider ack id is NEVER fabricated: absent a RUID, provider_ack_id
 * stays null even on a proven success.
 */
function decodeAvailabilityAckXml(raw) {
  raw = raw || {};
  if (raw.error === 'transport_disabled') {
    return { ok: false, status: 0, retryable: false, errors: [{ code: 'transport_disabled', message: 'OTA HTTP transport disabled' }], warnings: [], raw };
  }
  const status = raw.status || 0;
  const text = typeof raw.bodyText === 'string' ? raw.bodyText : null;
  const httpOk = !!raw.ok && status >= 200 && status < 300;

  const errorsPresent = !!(text && (hasXmlTag(text, 'errors') || /<error\b/i.test(text)));
  const ruid = text ? extractRuid(text) : null;

  if (httpOk && !errorsPresent) {
    // Class A (pure <ok/>) and Class B (success + <warnings>) both succeed.
    const warnings = text ? extractBookingComWarnings(text) : [];
    const okTagPresent = text ? (hasXmlTag(text, 'ok') || hasXmlTag(text, 'Ok') || hasXmlTag(text, 'success')) : false;
    return { ok: true, ackId: ruid || null, status, errors: [], warnings, raw: Object.assign({}, raw, { xmlOkTagPresent: okTagPresent }) };
  }

  // Class C (errors, HTTP 4xx/5xx) and Class D (errors, HTTP 200) both fail.
  // A Class-D response (errors embedded despite HTTP 2xx) is a definitive
  // provider-side rejection of this one update, not a transient network
  // condition — classified non-retryable, distinct from a genuine
  // transport-level HTTP failure (still classifyHttpStatus()-driven).
  const extractedErrors = text ? extractBookingComErrors(text) : [];
  const retryable = errorsPresent && httpOk ? false : classifyHttpStatus(status);
  const errors = extractedErrors.length
    ? extractedErrors
    : (text && errorsPresent
        ? [{ code: 'booking_com_xml_error', message: extractXmlTagText(text, 'message') || 'Booking.com returned an <errors> response' }]
        : [{ code: 'http_' + status, message: raw.error || ('Booking.com error ' + status) }]);
  return { ok: false, status, retryable, errors, warnings: [], ackId: ruid || null, raw };
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
   * synchronously from an already-resolved secret. The CURRENT ARI
   * dispatcher no longer uses this function for BOOKING_COM at all — see
   * src/ari/dispatch/ariChannelDispatcher.js, which now REQUIRES a
   * bookingComTokenProvider and fails closed before any HTTP dispatch if one
   * is not configured (instruction 049 Section 18). This function remains
   * only for generic/legacy call sites and other providers' shared
   * conventions — it is never itself upgraded to emit a Bearer header, and
   * it is never used as a fallback from a failed/absent token path.
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

module.exports = {
  bookingcom, AVAILABILITY_ENDPOINT, AVAILABILITY_ACCEPT_VERSION, MAX_ROOMS_TO_SELL,
  buildAvailabilityXml, decodeAvailabilityAckXml, isValidBookingComRoomId, isValidCalendarDate,
  extractBookingComErrors, extractBookingComWarnings
};
