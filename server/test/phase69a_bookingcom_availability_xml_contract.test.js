'use strict';

/**
 * Phase 69A (instruction 048) — Booking.com availability endpoint contract
 * alignment: POST /hotels/xml/availability, application/xml, Accept-Version
 * 1.1, deterministic escaped B.XML request, XML-aware ack decoding.
 * Pure NO-NETWORK unit tests. Does NOT assert provider acceptance — only
 * QYRVIA's own wire-format construction and response parsing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  bookingcom, AVAILABILITY_ENDPOINT, AVAILABILITY_ACCEPT_VERSION, buildAvailabilityXml, decodeAvailabilityAckXml
} = require('../src/channel-manager/ota/providers/bookingcom');
const { buildOtaTransport } = require('../src/channel-manager/ota/transport');

const INV = { hotelCode: 'H1', otaRoomId: 'R1', date: '2026-08-01', available: 5, stop_sell: false };

// ---- endpoint / method / scheme / headers ---------------------------------

test('endpointFor(pushAvailability) defaults to the documented Booking.com endpoint when no override is supplied', () => {
  assert.equal(bookingcom.endpointFor('pushAvailability', {}), AVAILABILITY_ENDPOINT);
  assert.equal(AVAILABILITY_ENDPOINT, 'https://supply-xml.booking.com/hotels/xml/availability');
  assert.ok(/^https:\/\//.test(AVAILABILITY_ENDPOINT), 'HTTPS');
});

test('endpointFor(pushAvailability) still honors an explicit ctx.endpoint override', () => {
  assert.equal(bookingcom.endpointFor('pushAvailability', { endpoint: 'https://fixture.test/avail' }), 'https://fixture.test/avail');
});

test('endpointFor(pushRateUpdate) is unchanged — null unless ctx.endpoint supplied (rate is out of this phase\'s scope)', () => {
  assert.equal(bookingcom.endpointFor('pushRateUpdate', {}), null);
  assert.equal(bookingcom.endpointFor('pushRateUpdate', { endpoint: 'https://x.test' }), 'https://x.test');
});

test('headersFor(pushAvailability) declares Content-Type application/xml and Accept-Version 1.1', () => {
  const h = bookingcom.headersFor('pushAvailability');
  assert.equal(h['Content-Type'], 'application/xml');
  assert.equal(h['Accept-Version'], AVAILABILITY_ACCEPT_VERSION);
  assert.equal(AVAILABILITY_ACCEPT_VERSION, '1.1');
});

test('headersFor(pushRateUpdate) declares no special headers (unchanged JSON path)', () => {
  assert.deepEqual(bookingcom.headersFor('pushRateUpdate'), {});
});

test('buildOtaTransport sends POST with the correct headers merged in for pushAvailability', async () => {
  let sent = null;
  const http = { enabled: true, async send(req) { sent = req; return { ok: true, status: 200, bodyText: '<response><ok/></response>' }; } };
  const t = buildOtaTransport({ provider: bookingcom, http });
  await t.pushAvailability(INV, { endpoint: AVAILABILITY_ENDPOINT });
  assert.equal(sent.endpoint, AVAILABILITY_ENDPOINT);
  assert.equal(sent.headers['Content-Type'], 'application/xml');
  assert.equal(sent.headers['Accept-Version'], '1.1');
  assert.equal(typeof sent.payload, 'string', 'the encoded availability payload is the raw XML string');
});

// ---- XML request serialization --------------------------------------------

test('buildAvailabilityXml produces deterministic output for identical input', () => {
  const a = buildAvailabilityXml(INV);
  const b = buildAvailabilityXml(INV);
  assert.equal(a, b);
});

test('buildAvailabilityXml includes correct mapped room id, hotel id, date, and rooms-to-sell', () => {
  const xml = buildAvailabilityXml(INV);
  assert.match(xml, /<hotel_id>H1<\/hotel_id>/);
  assert.match(xml, /<room id="R1">/);
  assert.match(xml, /<date value="2026-08-01">/);
  assert.match(xml, /<rooms_to_sell>5<\/rooms_to_sell>/);
  assert.match(xml, /<closed>false<\/closed>/);
});

test('buildAvailabilityXml reflects stop_sell/stopSell as <closed>true</closed>', () => {
  const xml1 = buildAvailabilityXml(Object.assign({}, INV, { stop_sell: true }));
  assert.match(xml1, /<closed>true<\/closed>/);
  const xml2 = buildAvailabilityXml(Object.assign({}, INV, { stop_sell: false, stopSell: true }));
  assert.match(xml2, /<closed>true<\/closed>/);
});

test('is well-formed enough for a real XML parser to accept (no runaway/unclosed tags)', () => {
  const xml = buildAvailabilityXml(INV);
  // A minimal well-formedness proxy without adding an XML dependency: every
  // opening tag has a matching closing tag in LIFO order, or is self-closing.
  const stack = [];
  const tagRe = /<\/?([a-zA-Z0-9_:-]+)(?:\s[^>]*)?\/?>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const full = m[0], name = m[1];
    if (full.startsWith('<?')) continue; // XML declaration
    if (full.endsWith('/>')) continue;   // self-closing
    if (full.startsWith('</')) {
      assert.equal(stack.pop(), name, 'closing tag must match the most recently opened tag: ' + full);
    } else {
      stack.push(name);
    }
  }
  assert.equal(stack.length, 0, 'every opened tag was closed');
});

test('XML escaping: a hostile mapped id cannot break out of its element/attribute', () => {
  const hostile = { hotelCode: 'H1', otaRoomId: 'R"1><evil>x</evil', date: '2026-08-01', available: 1, stop_sell: false };
  const xml = buildAvailabilityXml(hostile);
  assert.ok(!/<evil>/.test(xml), 'raw injected tag must never appear unescaped');
  assert.match(xml, /&quot;|&gt;|&lt;/, 'the hostile characters were escaped, not passed through raw');
});

// ---- validation / fail-closed ----------------------------------------------

test('missing hotel id fails closed (throws, non-retryable)', () => {
  assert.throws(() => buildAvailabilityXml({ otaRoomId: 'R1', date: '2026-08-01', available: 1 }),
    (e) => e.code === 'BOOKING_COM_XML_MISSING_HOTEL_ID' && e.retryable === false);
});
test('missing room id fails closed', () => {
  assert.throws(() => buildAvailabilityXml({ hotelCode: 'H1', date: '2026-08-01', available: 1 }),
    (e) => e.code === 'BOOKING_COM_XML_MISSING_ROOM_ID' && e.retryable === false);
});
test('invalid (non-ISO) date fails closed', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { date: '08/01/2026' })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_DATE');
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { date: null })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_DATE');
});
test('invalid (negative or non-integer) rooms-to-sell fails closed, never fabricated', () => {
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: -1 })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: 1.5 })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
  assert.throws(() => buildAvailabilityXml(Object.assign({}, INV, { available: undefined })),
    (e) => e.code === 'BOOKING_COM_XML_INVALID_QUANTITY');
});

// ---- ack decoding -----------------------------------------------------------

test('decodeAck(pushAvailability) treats transport_disabled exactly like every other op — non-retryable, no network claim', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { error: 'transport_disabled' });
  assert.equal(ack.ok, false);
  assert.equal(ack.retryable, false);
  assert.equal(ack.errors[0].code, 'transport_disabled');
});

test('decodeAck(pushAvailability): 2xx is success, and a <ruid> in the XML body is captured as ackId', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<response><ruid>RUID-123</ruid></response>' });
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, 'RUID-123');
});

test('decodeAck(pushAvailability): 2xx success with NO ruid tag still succeeds, ackId is null (never fabricated)', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: '<response><ok/></response>' });
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, null);
});

test('decodeAck(pushAvailability): success with an empty/absent body still succeeds off HTTP status alone', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: true, status: 200, bodyText: null });
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, null);
});

test('decodeAck(pushAvailability): 4xx/5xx classification matches the shared HTTP-status convention', () => {
  assert.equal(bookingcom.decodeAck('pushAvailability', { ok: false, status: 429, bodyText: null }).retryable, true);
  assert.equal(bookingcom.decodeAck('pushAvailability', { ok: false, status: 503, bodyText: null }).retryable, true);
  assert.equal(bookingcom.decodeAck('pushAvailability', { ok: false, status: 401, bodyText: null }).retryable, false);
  assert.equal(bookingcom.decodeAck('pushAvailability', { ok: false, status: 400, bodyText: null }).retryable, false);
});

test('decodeAck(pushAvailability): an error/message tag in a failure body is surfaced', () => {
  const ack = bookingcom.decodeAck('pushAvailability', { ok: false, status: 400, bodyText: '<response><error>invalid room id</error></response>' });
  assert.equal(ack.errors[0].code, 'booking_com_xml_error');
  assert.equal(ack.errors[0].message, 'invalid room id');
});

test('decodeAck(pushAvailability): malformed/non-XML body never throws, degrades to the http_<status> fallback', () => {
  assert.doesNotThrow(() => bookingcom.decodeAck('pushAvailability', { ok: false, status: 500, bodyText: 'not xml at all <<<' }));
  const ack = bookingcom.decodeAck('pushAvailability', { ok: false, status: 500, bodyText: 'not xml at all <<<' });
  assert.equal(ack.errors[0].code, 'http_500');
});

test('decodeAvailabilityAckXml is exported directly and matches bookingcom.decodeAck(\'pushAvailability\', ...)', () => {
  const raw = { ok: true, status: 200, bodyText: '<response><ruid>X1</ruid></response>' };
  assert.deepEqual(decodeAvailabilityAckXml(raw), bookingcom.decodeAck('pushAvailability', raw));
});

// ---- rate op is UNCHANGED (out of scope, still JSON) -----------------------

test('decodeAck(pushRateUpdate) is UNCHANGED — still reads JSON body.confirmation_id', () => {
  const ack = bookingcom.decodeAck('pushRateUpdate', { ok: true, status: 200, body: { confirmation_id: 'C9' } });
  assert.equal(ack.ackId, 'C9');
});
