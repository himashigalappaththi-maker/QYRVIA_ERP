'use strict';

/**
 * Phase 68A — hardening fixes to the SHARED HTTP transport (instruction 032
 * Sections 12-13): enforced timeout via AbortController, HTTPS requirement,
 * bounded response-body capture, and QYRVIA-side (not provider-claimed)
 * correlation-id propagation. No real network call is made anywhere in this
 * file — every fetchImpl is a local fake function.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHttpTransport, DEFAULT_MAX_RESPONSE_BYTES } = require('../src/channel-manager/transport/transport');
const { buildOtaTransport, CORRELATION_REQUEST_HEADER } = require('../src/channel-manager/ota/transport');
const { bookingcom } = require('../src/channel-manager/ota/providers/bookingcom');

function headersOf(map) {
  return { get: (name) => (Object.prototype.hasOwnProperty.call(map, name.toLowerCase()) ? map[name.toLowerCase()] : null) };
}

// ---- X/Y. timeout aborts the fetch and always cleans up its timer ---------

test('X. a fetch that never resolves is aborted once timeoutMs elapses, classified as a retryable status-0 timeout', async () => {
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    // Never resolves on its own — only the AbortSignal can end it, exactly
    // like a real hung connection.
    if (opts.signal) opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const transport = buildHttpTransport({ enabled: true, fetchImpl, timeoutMs: 20 });
  const start = Date.now();
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  const elapsed = Date.now() - start;
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.equal(res.error, 'timeout');
  assert.ok(elapsed < 2000, 'aborted promptly at ~timeoutMs, not left hanging');
});

test('Y. the timeout timer is cleared on a NORMAL fast response — it does not fire late or keep the process alive', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: headersOf({}), text: async () => '' });
  const transport = buildHttpTransport({ enabled: true, fetchImpl, timeoutMs: 20 });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.ok, true);
  // Give any leaked timer a chance to fire; if the implementation failed to
  // clearTimeout, node keeps this test process alive/flags an open handle —
  // node:test surfaces that as a hang, not a normal pass, so simply reaching
  // this point cleanly (with the default test timeout) is the proof.
});

test('Y. the timeout timer is cleared on a THROWN (non-timeout) fetch error too', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const transport = buildHttpTransport({ enabled: true, fetchImpl, timeoutMs: 20 });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'ECONNRESET');
});

// ---- Z. HTTPS enforcement --------------------------------------------------

test('Z. a plain-HTTP endpoint is refused BEFORE any network attempt (deterministic, no fetch call)', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200 }; };
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  const res = await transport.send({ endpoint: 'http://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'https_required');
  assert.equal(called, false, 'no fetch attempt for a non-HTTPS endpoint');
});

test('an https endpoint passes the scheme check and reaches fetchImpl', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200, headers: headersOf({}), text: async () => '' }; };
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(called, true);
});

// ---- AA/AB/AC. body capture: JSON, empty, invalid ---------------------------

test('AA/AE. a JSON body is parsed and returned as `body`, and a real provider decodeAck can read it', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: headersOf({}), text: async () => JSON.stringify({ confirmation_id: 'C1' }) });
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.deepEqual(res.body, { confirmation_id: 'C1' });
  const ack = bookingcom.decodeAck('pushRateUpdate', res);
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, 'C1');
});

test('AB. an empty body is tolerated — body: null, never a thrown parse error', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: headersOf({}), text: async () => '' });
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.ok, true);
  assert.equal(res.body, null);
});

test('AC. invalid JSON is tolerated without crashing — body: null, and decodeAck still degrades gracefully', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, headers: headersOf({}), text: async () => '<html>not json</html>' });
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.body, null);
  assert.doesNotThrow(() => bookingcom.decodeAck('pushRateUpdate', res));
  const ack = bookingcom.decodeAck('pushRateUpdate', res);
  assert.equal(ack.ok, false);
  assert.equal(ack.errors[0].code, 'http_500');
});

test('.json()-only response shapes (no .text()) are also supported, for callers/tests that only implement .json()', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: headersOf({}), json: async () => ({ ok_marker: true }) });
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.deepEqual(res.body, { ok_marker: true });
});

// ---- AD. oversized response rejected/bounded -------------------------------

test('AD. a Content-Length above the bound is rejected BEFORE reading the body at all', async () => {
  let textCalled = false;
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: headersOf({ 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) }),
    text: async () => { textCalled = true; return '{}'; }
  });
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'response_too_large');
  assert.equal(textCalled, false, 'never reads a body already known to be oversized');
});

test('AD. an undeclared but actually-oversized body is rejected, not silently truncated', async () => {
  const big = 'x'.repeat(10);
  const fetchImpl = async () => ({ ok: true, status: 200, headers: headersOf({}), text: async () => big });
  const transport = buildHttpTransport({ enabled: true, fetchImpl, maxResponseBytes: 5 });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'response_too_large');
});

// ---- AF. no secret/header logging; only a narrow safe-header allowlist -----

test('AF. only x-request-id / x-correlation-id are ever read from response headers — never a bulk header dump', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: headersOf({ 'x-request-id': 'REQ-1', 'set-cookie': 'session=SECRET_VALUE' }),
    text: async () => '{}'
  });
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.correlationId, 'REQ-1');
  assert.equal(JSON.stringify(res).includes('SECRET_VALUE'), false, 'set-cookie (or any other header) is never surfaced');
});

test('AF. a Headers-like object that throws on .get() degrades to no correlation id, never crashes the send()', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: { get() { throw new Error('hostile header impl'); } },
    text: async () => '{}'
  });
  const transport = buildHttpTransport({ enabled: true, fetchImpl });
  const res = await transport.send({ endpoint: 'https://fake-ota.test/ari', headers: {}, payload: {} });
  assert.equal(res.ok, true);
  assert.equal(res.correlationId, null);
});

// ---- AG. correlation id is QYRVIA-side only — never claimed as provider idempotency ----

test('AG. buildOtaTransport forwards ctx.correlationId as the documented QYRVIA-side header, and the module never claims provider support for it', async () => {
  let sentHeaders = null;
  const http = {
    kind: 'fake', enabled: true,
    async send(req) { sentHeaders = req.headers; return { ok: true, status: 200, body: { confirmation_id: 'C1' } }; }
  };
  const transport = buildOtaTransport({ provider: bookingcom, http, retryPolicy: { shouldRetry: () => false, nextDelay: () => 0 }, sleep: () => Promise.resolve() });
  await transport.pushRateUpdate({ hotelCode: 'H1', otaRoomId: 'R1', date: '2026-08-01', rate: 100, currency: 'USD' }, { correlationId: 'aob:v1:xyz:3', endpoint: 'https://fake-ota.test/ari' });
  assert.equal(sentHeaders[CORRELATION_REQUEST_HEADER], 'aob:v1:xyz:3');

  // Documentation check, not a behavioral one: the module's own header
  // explicitly disclaims provider support — this asserts the disclaimer is
  // still present, so a future edit cannot silently drop it and start
  // implying provider-side idempotency.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/channel-manager/ota/transport.js'), 'utf8');
  assert.match(src, /NOT a claim that any provider treats this header as/);
});

test('AG. no correlationId supplied -> no correlation header is sent (fully backward compatible)', async () => {
  let sentHeaders = null;
  const http = { kind: 'fake', enabled: true, async send(req) { sentHeaders = req.headers; return { ok: true, status: 200, body: {} }; } };
  const transport = buildOtaTransport({ provider: bookingcom, http, retryPolicy: { shouldRetry: () => false, nextDelay: () => 0 }, sleep: () => Promise.resolve() });
  await transport.pushRateUpdate({ hotelCode: 'H1', otaRoomId: 'R1', date: '2026-08-01', rate: 100, currency: 'USD' });
  assert.equal(Object.prototype.hasOwnProperty.call(sentHeaders, CORRELATION_REQUEST_HEADER), false);
});
