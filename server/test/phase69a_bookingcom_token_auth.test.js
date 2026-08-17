'use strict';

/**
 * Phase 69A (instruction 048) — Booking.com token-based authentication.
 * Pure NO-NETWORK unit tests against a fully injected fake HTTP transport —
 * zero real network calls, matching every other transport test in this repo.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBookingComTokenProvider, classifyTokenExchangeStatus, safeParseJwtExpiryMs, TOKEN_EXCHANGE_ENDPOINT
} = require('../src/channel-manager/adapters/bookingcom/tokenProvider');

function makeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return header + '.' + payload + '.fakesig';
}

/** Deferred-response fake — response resolution is controlled externally, for single-flight proof. */
function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    async send(req) { calls.push(req); return handler(req, calls.length - 1); }
  };
}

function fixedHttp(responses) {
  let i = 0;
  return fakeHttp(() => {
    const r = typeof responses === 'function' ? responses(i) : responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  });
}

test('client_id/client_secret are sent ONLY to the mocked token exchange, nowhere else', async () => {
  const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const http = fixedHttp([{ ok: true, status: 200, body: { jwt } }]);
  const tp = buildBookingComTokenProvider({ http });
  await tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid-1', clientSecret: 'sec-1' });
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].endpoint, TOKEN_EXCHANGE_ENDPOINT);
  assert.deepEqual(http.calls[0].payload, { client_id: 'cid-1', client_secret: 'sec-1' });
  assert.equal(http.calls[0].headers['Content-Type'], 'application/json');
});

test('Bearer Authorization header is generated from the exchanged JWT', async () => {
  const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const http = fixedHttp([{ ok: true, status: 200, body: { jwt } }]);
  const tp = buildBookingComTokenProvider({ http });
  const headers = await tp.toAuthHeaders({ credentialsRef: 'ref-1', secret: { client_id: 'cid', client_secret: 'sec' } });
  assert.equal(headers.Authorization, 'Bearer ' + jwt);
});

test('no Basic fallback: a failed exchange REJECTS rather than degrading to any other header shape', async () => {
  const http = fixedHttp([{ ok: false, status: 401, body: {} }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(
    () => tp.toAuthHeaders({ credentialsRef: 'ref-1', secret: { client_id: 'cid', client_secret: 'sec' } }),
    (e) => e.code === 'BOOKING_COM_TOKEN_INVALID_CREDENTIALS' && e.retryable === false
  );
});

test('toAuthHeaders returns {} (no header) for a non-token-shaped secret — never throws, never guesses', async () => {
  const tp = buildBookingComTokenProvider({});
  assert.deepEqual(await tp.toAuthHeaders({ credentialsRef: 'r', secret: { api_key: 'legacy' } }), {});
  assert.deepEqual(await tp.toAuthHeaders({ credentialsRef: 'r', secret: null }), {});
});

test('token is cached — a second getToken() before expiry makes NO further exchange call', async () => {
  const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const http = fixedHttp([{ ok: true, status: 200, body: { jwt } }]);
  const tp = buildBookingComTokenProvider({ http });
  const a = await tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  const b = await tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  assert.equal(http.calls.length, 1);
  assert.equal(a.token, jwt);
  assert.equal(b.token, jwt);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
});

test('expiry causes a refresh — a getToken() call past the cached expiry re-exchanges', async () => {
  let now = 1_000_000_000;
  const clock = () => now;
  const jwt1 = makeJwt({ exp: Math.floor(now / 1000) + 100 }); // expires in 100s
  const jwt2 = makeJwt({ exp: Math.floor(now / 1000) + 10000 });
  const http = fixedHttp([{ ok: true, status: 200, body: { jwt: jwt1 } }, { ok: true, status: 200, body: { jwt: jwt2 } }]);
  const tp = buildBookingComTokenProvider({ http, clock, skewMs: 0 });
  const a = await tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  assert.equal(a.token, jwt1);
  now += 100 * 1000 + 1000; // advance past jwt1's expiry
  const b = await tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  assert.equal(b.token, jwt2);
  assert.equal(http.calls.length, 2);
});

test('refresh skew: a getToken() call inside the skew window before expiry ALSO refreshes early', async () => {
  let now = 1_000_000_000;
  const clock = () => now;
  const jwt1 = makeJwt({ exp: Math.floor(now / 1000) + 100 }); // expires in 100s
  const jwt2 = makeJwt({ exp: Math.floor(now / 1000) + 10000 });
  const http = fixedHttp([{ ok: true, status: 200, body: { jwt: jwt1 } }, { ok: true, status: 200, body: { jwt: jwt2 } }]);
  const tp = buildBookingComTokenProvider({ http, clock, skewMs: 30 * 1000 }); // 30s skew
  await tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  now += 80 * 1000; // 20s before jwt1's real expiry, but INSIDE the 30s skew window
  const b = await tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  assert.equal(b.token, jwt2);
  assert.equal(http.calls.length, 2);
});

test('concurrent token requests for the SAME credential coalesce to a single exchange (single-flight)', async () => {
  const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  let resolveExchange;
  const gate = new Promise((r) => { resolveExchange = r; });
  const http = fakeHttp(async () => { await gate; return { ok: true, status: 200, body: { jwt } }; });
  const tp = buildBookingComTokenProvider({ http });

  const p1 = tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  const p2 = tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  const p3 = tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  resolveExchange();
  const [a, b, c] = await Promise.all([p1, p2, p3]);
  assert.equal(http.calls.length, 1, 'exactly one exchange for three concurrent callers');
  assert.equal(a.token, jwt); assert.equal(b.token, jwt); assert.equal(c.token, jwt);
});

test('a failed exchange clears in-flight state so a LATER call can retry', async () => {
  const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const http = fixedHttp([{ ok: false, status: 500, body: {} }, { ok: true, status: 200, body: { jwt } }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' }));
  const b = await tp.getToken({ credentialsRef: 'ref-1', clientId: 'cid', clientSecret: 'sec' });
  assert.equal(b.token, jwt);
  assert.equal(http.calls.length, 2, 'the retry after failure made its OWN exchange call, not a stuck in-flight one');
});

// ---- error classification -------------------------------------------------

test('classifyTokenExchangeStatus: 400 -> permanent/non-retryable', () => {
  assert.deepEqual(classifyTokenExchangeStatus(400), { retryable: false, code: 'BOOKING_COM_TOKEN_BAD_REQUEST' });
});
test('classifyTokenExchangeStatus: 401 -> permanent invalid/revoked credentials', () => {
  assert.deepEqual(classifyTokenExchangeStatus(401), { retryable: false, code: 'BOOKING_COM_TOKEN_INVALID_CREDENTIALS' });
});
test('classifyTokenExchangeStatus: 429 -> retryable/rate limited', () => {
  assert.deepEqual(classifyTokenExchangeStatus(429), { retryable: true, code: 'BOOKING_COM_TOKEN_RATE_LIMITED' });
});
test('classifyTokenExchangeStatus: 5xx -> retryable', () => {
  assert.equal(classifyTokenExchangeStatus(500).retryable, true);
  assert.equal(classifyTokenExchangeStatus(503).retryable, true);
});

test('getToken rejects with the classified 400 error end-to-end', async () => {
  const http = fixedHttp([{ ok: false, status: 400, body: {} }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: 'c', clientSecret: 's' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_BAD_REQUEST' && e.retryable === false);
});
test('getToken rejects with the classified 401 error end-to-end', async () => {
  const http = fixedHttp([{ ok: false, status: 401, body: {} }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: 'c', clientSecret: 's' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_INVALID_CREDENTIALS' && e.retryable === false);
});
test('getToken rejects with the classified 429 error end-to-end', async () => {
  const http = fixedHttp([{ ok: false, status: 429, body: {} }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: 'c', clientSecret: 's' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_RATE_LIMITED' && e.retryable === true);
});
test('getToken rejects with the classified 5xx error end-to-end', async () => {
  const http = fixedHttp([{ ok: false, status: 503, body: {} }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: 'c', clientSecret: 's' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_SERVER_ERROR' && e.retryable === true);
});
test('getToken classifies a timeout as retryable', async () => {
  const http = fixedHttp([{ ok: false, status: 0, error: 'timeout' }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: 'c', clientSecret: 's' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_TIMEOUT' && e.retryable === true);
});
test('getToken classifies a thrown network error as retryable', async () => {
  const http = { async send() { throw new Error('ECONNRESET'); } };
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: 'c', clientSecret: 's' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_NETWORK_ERROR' && e.retryable === true);
});
test('getToken fails closed (non-retryable) on missing client_id/client_secret, WITHOUT calling http.send', async () => {
  const http = fixedHttp([{ ok: true, status: 200, body: { jwt: 'x' } }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: '', clientSecret: '' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_MISSING_CLIENT_CREDENTIALS' && e.retryable === false);
  assert.equal(http.calls.length, 0);
});
test('getToken fails closed (non-retryable) when the exchange response has no jwt field', async () => {
  const http = fixedHttp([{ ok: true, status: 200, body: { not_a_jwt: true } }]);
  const tp = buildBookingComTokenProvider({ http });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: 'c', clientSecret: 's' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_MISSING_JWT_IN_RESPONSE' && e.retryable === false);
});

// ---- isolation --------------------------------------------------------

test('credential-ref isolation: two distinct credentialsRef never share a cache entry, even with identical client_id', async () => {
  const jwtA = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'A' });
  const jwtB = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'B' });
  let i = 0;
  const http = fakeHttp(() => ({ ok: true, status: 200, body: { jwt: i++ === 0 ? jwtA : jwtB } }));
  const tp = buildBookingComTokenProvider({ http });
  const a = await tp.getToken({ credentialsRef: 'tenantA:ref', clientId: 'same-cid', clientSecret: 'secA' });
  const b = await tp.getToken({ credentialsRef: 'tenantB:ref', clientId: 'same-cid', clientSecret: 'secB' });
  assert.notEqual(a.token, b.token);
  assert.equal(http.calls.length, 2, 'each distinct credentialsRef is exchanged independently, never reused across tenants');
  assert.deepEqual(http.calls[0].payload, { client_id: 'same-cid', client_secret: 'secA' });
  assert.deepEqual(http.calls[1].payload, { client_id: 'same-cid', client_secret: 'secB' });
});

test('invalidate(credentialsRef) discards only that credential\'s cached token', async () => {
  const jwt1 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const jwt2 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const http = fixedHttp([{ ok: true, status: 200, body: { jwt: jwt1 } }, { ok: true, status: 200, body: { jwt: jwt2 } }]);
  const tp = buildBookingComTokenProvider({ http });
  await tp.getToken({ credentialsRef: 'ref-1', clientId: 'c', clientSecret: 's' });
  tp.invalidate('ref-1');
  const b = await tp.getToken({ credentialsRef: 'ref-1', clientId: 'c', clientSecret: 's' });
  assert.equal(b.token, jwt2);
  assert.equal(http.calls.length, 2);
});

// ---- no secret/token logging -------------------------------------------

test('token and client_secret are NEVER passed to the logger — only safe metadata', async () => {
  const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const http = fixedHttp([{ ok: true, status: 200, body: { jwt } }, { ok: false, status: 401, body: {} }]);
  const logged = [];
  const logger = { info: (m, msg) => logged.push([m, msg]), warn: (m, msg) => logged.push([m, msg]) };
  const tp = buildBookingComTokenProvider({ http, logger });
  await tp.getToken({ credentialsRef: 'ref-1', clientId: 'CLIENT-ID-1', clientSecret: 'TOP-SECRET-VALUE' });
  await assert.rejects(() => tp.getToken({ credentialsRef: 'ref-2', clientId: 'c2', clientSecret: 'TOP-SECRET-VALUE-2' }));

  assert.ok(logged.length >= 2, 'both success and failure paths logged something');
  const serialized = JSON.stringify(logged);
  assert.ok(!serialized.includes(jwt), 'the raw JWT must never appear in a logged payload');
  assert.ok(!serialized.includes('TOP-SECRET-VALUE'), 'client_secret must never appear in a logged payload');
  assert.ok(!serialized.includes('TOP-SECRET-VALUE-2'));
});

test('safeParseJwtExpiryMs reads the exp claim correctly and degrades to null on malformed input', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  assert.equal(safeParseJwtExpiryMs(makeJwt({ exp: nowSec + 60 })), (nowSec + 60) * 1000);
  assert.equal(safeParseJwtExpiryMs('not-a-jwt'), null);
  assert.equal(safeParseJwtExpiryMs('a.b'), null);
  assert.equal(safeParseJwtExpiryMs(makeJwt({ no_exp: true })), null);
});

test('a token exchange is NEVER attempted when the injected http transport is left at its default (disabled) — zero network by construction', async () => {
  const tp = buildBookingComTokenProvider({}); // no http injected -> disabled stub
  await assert.rejects(() => tp.getToken({ credentialsRef: 'r', clientId: 'c', clientSecret: 's' }),
    (e) => e.code === 'BOOKING_COM_TOKEN_TRANSPORT_DISABLED' && e.retryable === true);
});
