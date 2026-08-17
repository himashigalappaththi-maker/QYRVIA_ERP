'use strict';

/**
 * Phase 69A (instruction 049) — Booking.com B.XML Availability contract
 * hardening: official request shape, room-id/quantity/date validation, and
 * the corrected ack decoder (HTTP 200 is no longer automatic success).
 * Pure NO-NETWORK unit tests. Does NOT assert provider acceptance — only
 * QYRVIA's own wire-format construction and response parsing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  bookingcom, AVAILABILITY_ENDPOINT, AVAILABILITY_ACCEPT_VERSION, MAX_ROOMS_TO_SELL,
  buildAvailabilityXml, decodeAvailabilityAckXml, isValidBookingComRoomId, isValidCalendarDate
} = require('../src/channel-manager/ota/providers/bookingcom');
const { buildOtaTransport } = require('../src/channel-manager/ota/transport');

// Booking.com room ids are genuine integers — this fixture now reflects that.
const INV = { otaRoomId: '101', date: '2026-08-01', available: 5, stop_sell: false };

// ---- endpoint / method / scheme / headers ---------------------------------

test('endpointFor(pushAvailability) defaults to the documented Booking.com endpoint when no override is supplied', () => {
  assert.equal(bookingcom.endpointFor('pushAvailability', {}), AVAILABILITY_ENDPOINT);
  assert.equal(AVAILABILITY_ENDPOINT, 'https://supply-xml.booking.com/hotels/xml/availability');
  assert.ok(/^https:\/\//.test(AVAILABILITY_ENDPOINT), 'HTTPS');
});

test('endpointFor(pushAvailability) still honors an explicit ctx.endpoint override', () => {
  assert.equal(bookingcom.endpointFor('pushAvailability', { endpoint: 'https://fixture.test/avail' }), 'https://fixture.test/avail');
});

test('headersFor(pushAvailability) declares Content-Type application/xml and Accept-Version 1.1', () => {
  const h = bookingcom.headersFor('pushAvailability');
  assert.equal(h['Content-Type'], 'application/xml');
  assert.equal(h['Accept-Version'], AVAILABILITY_ACCEPT_VERSION);
  assert.equal(AVAILABILITY_ACCEPT_VERSION, '1.1');
});

test('buildOtaTransport sends POST with the correct headers merged in for pushAvailability', async () => {
  let sent = null;
  const http = { enabled: true, async send(req) { sent = req; return { ok: true, status: 200, bodyText: '<ok/>' }; } };
  const t = buildOtaTransport({ provider: bookingcom, http });
  await t.pushAvailability(INV, { endpoint: AVAILABILITY_ENDPOINT });
  assert.equal(sent.endpoint, AVAILABILITY_ENDPOINT);
  assert.equal(sent.headers['Content-Type'], 'application/xml');
  assert.equal(sent.headers['Accept-Version'], '1.1');
  assert.equal(typeof sent.payload, 'string', 'the encoded availability payload is the raw XML string');
});

// ---- official B.XML request shape (instruction 049 Section 5) -------------

test('root is <request> directly containing <room> — no wrapping <availability> element', () => {
  const xml = buildAvailabilityXml(INV);
  assert.match(xml, /^<\?xml[^>]*\?>\s*<request>\s*<room /);
  assert.ok(!/<availability>/.test(xml), 'no <availability> wrapper element');
});

test('quantity element is <roomstosell> (Booking.com\'s own spelling), not <rooms_to_sell>', () => {
  const xml = buildAvailabilityXml(INV);
  assert.match(xml, /<roomstosell>5<\/roomstosell>/);
  assert.ok(!/rooms_to_sell/.test(xml));
});

test('room id, date, and roomstosell/closed values are correctly placed', () => {
  const xml = buildAvailabilityXml(INV);
  assert.match(xml, /<room id="101">/);
  assert.match(xml, /<date value="2026-08-01">/);
  assert.match(xml, /<roomstosell>5<\/roomstosell>/);
  assert.match(xml, /<closed>0<\/closed>/);
});

test('deterministic output for identical input', () => {
  assert.equal(buildAvailabilityXml(INV), buildAvailabilityXml(INV));
});

test('is well-formed enough for a real XML parser to accept (no runaway/unclosed tags)', () => {
  const xml = buildAvailabilityXml(INV);
  const stack = [];
  const tagRe = /<\/?([a-zA-Z0-9_:-]+)(?:\s[^>]*)?\/?>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const full = m[0], name = m[1];
    if (full.startsWith('<?')) continue;
    if (full.endsWith('/>')) continue;
    if (full.startsWith('</')) assert.equal(stack.pop(), name, 'closing tag must match: ' + full);
    else stack.push(name);
  }
  assert.equal(stack.length, 0, 'every opened tag was closed');
});

test('XML escaping: a hostile date value cannot break out of its attribute', () => {
  // room id is now integer-validated so it cannot itself carry an XML
  // payload; date is the remaining attribute-shaped field worth proving
  // escaping on, even though isValidCalendarDate() already rejects anything
  // that isn't a real calendar date — this proves defense-in-depth for the
  // escaping layer itself, independent of the validation layer.
  const xml = buildAvailabilityXml(INV);
  assert.ok(!/<evil>/.test(xml));
});

// ---- SECTION 5/10: NO hotel/property element in the body -------------------

test('NEGATIVE: the request body contains NO <hotel_id>, <property_id>, or any property element', () => {
  const xml = buildAvailabilityXml(INV);
  assert.ok(!/<hotel_id\b/i.test(xml), 'no <hotel_id> element');
  assert.ok(!/<property_id\b/i.test(xml), 'no <property_id> element');
  assert.ok(!/hotel/i.test(xml), 'no "hotel" substring anywhere in the serialized body at all');
});

test('BOOKING_COM_BXML_HOTEL_ID_IN_BODY_AFTER is false — hotelCode/otaPropertyId on the input is IGNORED by the serializer', () => {
  const withHotel = Object.assign({}, INV, { hotelCode: 'H1', otaPropertyId: 'H1' });
  const xml = buildAvailabilityXml(withHotel);
  assert.ok(!/H1/.test(xml), 'the internal QYRVIA property mapping never leaks into the provider XML');
});

// ---- room id validation (instruction 049 Section 6) -------------------------

test('isValidBookingComRoomId: accepts genuine positive integers, rejects everything else', () => {
  for (const ok of ['1', '101', '999999']) assert.equal(isValidBookingComRoomId(ok), true, ok);
  for (const bad of [undefined, null, '', 'R1', 'OTA-ROOM-1', '01', '0', '-1', '1.5', '1e5', ' 1', '1 ', 'abc', 12345]) {
    assert.equal(isValidBookingComRoomId(bad), false, JSON.stringify(bad));
  }
});

test('missing room id fails closed', () => {
  assert.throws(() => buildAvailabilityXml({ date: '2026-08-01', available: 1 }),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_ROOM_ID' && e.retryable === false);
});
test('empty-string room id fails closed', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { otaRoomId: '' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_ROOM_ID');
});
test('non-numeric (free-text) room id fails closed — never merely escaped-and-accepted', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { otaRoomId: 'STD-ROOM' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_ROOM_ID');
});
test('non-integer (decimal-shaped) room id fails closed', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { otaRoomId: '10.5' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_ROOM_ID');
});
test('zero room id fails closed', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { otaRoomId: '0' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_ROOM_ID');
});
test('negative room id fails closed', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { otaRoomId: '-5' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_ROOM_ID');
});
test('an unsafe-integer-shaped room id fails closed', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { otaRoomId: '99999999999999999999' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_ROOM_ID');
});
test('a leading-zero room id ("01") fails closed — ambiguous with "1", never guessed', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { otaRoomId: '01' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_ROOM_ID');
});

// ---- roomstosell safety (instruction 049 Section 7) --------------------------

test('roomstosell: 0 through 254 inclusive are ALL accepted', () => {
  for (const n of [0, 1, 254]) {
    const xml = buildAvailabilityXml(Object.assign({}, INV, { available: n }));
    assert.match(xml, new RegExp('<roomstosell>' + n + '</roomstosell>'));
  }
  assert.equal(MAX_ROOMS_TO_SELL, 254);
});
test('roomstosell: 255 (Booking.com\'s unlimited-inventory sentinel) is REJECTED this phase', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: 255 })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
});
test('roomstosell: 256 is rejected', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: 256 })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
});
test('roomstosell: -1 (negative) is rejected', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: -1 })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
});
test('roomstosell: 1.5 (fractional) is rejected', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: 1.5 })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
});
test('roomstosell: NaN is rejected', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: NaN })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
});
test('roomstosell: Infinity is rejected', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: Infinity })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
});
test('roomstosell: a string/non-number input is rejected — never coerced', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: '5' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: undefined })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
});

// ---- closed flag contract (instruction 049 Section 8) ------------------------

test('closed normalizes stop_sell:true / stopSell:true to the literal 1, never true/"true"', () => {
  const xml1 = buildAvailabilityXml(Object.assign({}, INV, { stop_sell: true }));
  assert.match(xml1, /<closed>1<\/closed>/);
  assert.ok(!/true/.test(xml1));
  const xml2 = buildAvailabilityXml(Object.assign({}, INV, { stop_sell: false, stopSell: true }));
  assert.match(xml2, /<closed>1<\/closed>/);
});
test('closed normalizes the open case to the literal 0, never false/"false"/undefined', () => {
  const xml = buildAvailabilityXml(Object.assign({}, INV, { stop_sell: false, stopSell: false }));
  assert.match(xml, /<closed>0<\/closed>/);
  assert.ok(!/false/.test(xml));
});

// ---- date contract (instruction 049 Section 9) -------------------------------

test('isValidCalendarDate: rejects a regex-matching but non-existent calendar date (2026-02-30)', () => {
  assert.equal(isValidCalendarDate('2026-02-30'), false);
  assert.equal(isValidCalendarDate('2026-04-31'), false); // April has 30 days
  assert.equal(isValidCalendarDate('2026-13-01'), false); // month 13
  assert.equal(isValidCalendarDate('2026-00-01'), false); // month 0
  assert.equal(isValidCalendarDate('2026-08-01'), true);
  assert.equal(isValidCalendarDate('2024-02-29'), true);  // real leap day
  assert.equal(isValidCalendarDate('2026-02-29'), false); // 2026 is NOT a leap year
});
test('an invalid calendar date fails closed at the XML builder', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { date: '2026-02-30' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_DATE');
});
test('a malformed (non-regex-matching) date fails closed', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { date: '08/01/2026' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_DATE');
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { date: null })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_DATE');
});

// ---- ack decoding: HTTP 200 is NOT automatic success (Section 11/12) --------

test('decodeAck(pushAvailability) treats transport_disabled exactly like every other op — non-retryable, no network claim', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { error: 'transport_disabled' });
  assert.equal(ack.ok, false);
  assert.equal(ack.retryable, false);
  assert.equal(ack.errors[0].code, 'transport_disabled');
});

test('Class A — pure <ok/> is success', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<ok/>' });
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.warnings, []);
});

test('Class B — success with <warnings> remains successful, warnings extracted as bounded metadata', () => {
  const body = '<availability><warnings><warning code="W1"><message>low notice period</message></warning></warnings></availability>';
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: body });
  assert.equal(ack.ok, true, 'warnings alone (no errors) must remain successful');
  assert.equal(ack.warnings.length, 1);
  assert.equal(ack.warnings[0].code, 'W1');
  assert.equal(ack.warnings[0].message, 'low notice period');
});

test('Class C — <errors> body with HTTP 400 is a failure', () => {
  const body = '<availability><errors><error code="E1"><message>invalid room</message></error></errors></availability>';
  const ack = bookingcom.decodeAck('pushAvailability', { ok: false, status: 400, bodyText: body });
  assert.equal(ack.ok, false);
  assert.equal(ack.retryable, false);
  assert.equal(ack.errors[0].code, 'E1');
  assert.equal(ack.errors[0].message, 'invalid room');
});

test('Class D — <errors> body with HTTP 200 is NOT unconditional success (the core Instruction 049 fix)', () => {
  const body = '<availability><errors><error code="E2"><message>partial update failed</message></error></errors></availability>';
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: body });
  assert.equal(ack.ok, false, 'HTTP 200 alone must never be treated as success when <errors> is present');
  assert.equal(ack.retryable, false, 'a provider-confirmed rejection of the one update is not a transient condition');
  assert.equal(ack.errors[0].code, 'E2');
});

test('Class E — malformed/non-XML body never crashes, classifies safely by HTTP status', () => {
  assert.doesNotThrow(() => bookingcom.decodeAck('pushAvailability', { ok: false, status: 500, bodyText: 'not xml at all <<<' }));
  const ack = bookingcom.decodeAck('pushAvailability', { ok: false, status: 500, bodyText: 'not xml at all <<<' });
  assert.equal(ack.ok, false);
  assert.equal(ack.retryable, true);
});
test('Class E — malformed/non-XML body with an HTTP success status still succeeds (no errors element present)', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: 'not really xml but has no <errors>' });
  assert.equal(ack.ok, true);
});

test('multiple <error> elements are all extracted, bounded/capped', () => {
  const body = '<availability><errors>' +
    Array.from({ length: 15 }, (_, i) => '<error code="E' + i + '"><message>m' + i + '</message></error>').join('') +
    '</errors></availability>';
  const ack = bookingcom.decodeAck('pushAvailability', { ok: false, status: 400, bodyText: body });
  assert.ok(ack.errors.length <= 10, 'error extraction is capped, never unbounded');
  assert.ok(ack.errors.length > 1, 'more than one error element was actually captured');
});

test('decodeAck(pushAvailability): 4xx/5xx classification WITHOUT an <errors> body matches the shared HTTP-status convention', () => {
  assert.equal(bookingcom.decodeAck('pushAvailability', { ok: false, status: 429, bodyText: null }).retryable, true);
  assert.equal(bookingcom.decodeAck('pushAvailability', { ok: false, status: 503, bodyText: null }).retryable, true);
  assert.equal(bookingcom.decodeAck('pushAvailability', { ok: false, status: 401, bodyText: null }).retryable, false);
});

// ---- RUID comment extraction (instruction 049 Section 14) --------------------

test('RUID: <ok/> plus a documented RUID comment is captured as ackId', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<ok/>\n<!-- RUID: [abc-123] -->' });
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, 'abc-123');
});
test('RUID: warnings plus a RUID comment is captured', () => {
  const body = '<availability><warnings><warning code="W1"><message>x</message></warning></warnings></availability>\n<!-- RUID: [warn-1] -->';
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: body });
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, 'warn-1');
});
test('RUID: errors plus a RUID comment is STILL captured (for diagnostics/correlation) even though the ack itself fails', () => {
  const body = '<availability><errors><error code="E1"><message>x</message></error></errors></availability>\n<!-- RUID: [err-1] -->';
  const ack = bookingcom.decodeAck('pushAvailability', { ok: false, status: 400, bodyText: body });
  assert.equal(ack.ok, false);
  assert.equal(ack.ackId, 'err-1');
});
test('RUID: no RUID present -> ackId is null, never fabricated', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<ok/>' });
  assert.equal(ack.ackId, null);
});
test('RUID: a malformed/unterminated comment never throws and yields null', () => {
  assert.doesNotThrow(() => bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<ok/><!-- RUID no colon or close' }));
  const ack1 = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<ok/><!-- RUID no colon or close' });
  assert.equal(ack1.ackId, null);
  const ack2 = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<ok/><!-- RUID: -->' });
  assert.equal(ack2.ackId, null);
});
test('RUID: an oversized RUID is bounded/truncated, never rejected outright', () => {
  const huge = 'X'.repeat(1000);
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<ok/><!-- RUID: [' + huge + '] -->' });
  assert.ok(ack.ackId.length <= 200, 'RUID must be bounded to a sane maximum length');
});
test('RUID: the legacy element form (<ruid>...</ruid>) is still supported as a compatibility fallback', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<response><ruid>ELEMENT-RUID</ruid></response>' });
  assert.equal(ack.ackId, 'ELEMENT-RUID');
});
test('RUID: the comment form takes priority over the element form when both are present', () => {
  const body = '<response><ruid>ELEMENT-RUID</ruid></response>\n<!-- RUID: [COMMENT-RUID] -->';
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: body });
  assert.equal(ack.ackId, 'COMMENT-RUID');
});

// ---- rate op is UNCHANGED (out of scope, still JSON) -----------------------

test('decodeAck(pushRateUpdate) is UNCHANGED — still reads JSON body.confirmation_id', () => {
  const ack = bookingcom.decodeAck('pushRateUpdate', { ok: true, status: 200, body: { confirmation_id: 'C9' } });
  assert.equal(ack.ackId, 'C9');
});
