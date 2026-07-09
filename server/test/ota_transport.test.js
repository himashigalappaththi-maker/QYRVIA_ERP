'use strict';

/** Phase 30.2 - OTA transport (codec/auth/retry/ack/rate-limit), reconciliation, monitoring. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildOtaTransport, buildRateLimiter, reconcile, buildSyncMonitor, providers } = require('../src/channel-manager/ota');
const { bookingcom } = require('../src/channel-manager/ota/providers/bookingcom');
const { expedia } = require('../src/channel-manager/ota/providers/expedia');
const { RetryPolicy } = require('../src/channel-manager/core/sync/RetryPolicy');

const fastRetry = new RetryPolicy({ maxAttempts: 4, baseMs: 1, factor: 1, maxMs: 1 });
const noSleep = () => Promise.resolve();
function fakeHttp(seq) { let i = 0; const sent = []; return { kind: 'fake', enabled: true, sent, async send(req) { sent.push(req); const r = typeof seq === 'function' ? seq(req, i) : seq[Math.min(i, seq.length - 1)]; i++; return r; }, async health() { return { ok: true }; } }; }

const RATE = { hotelCode: 'H1', otaRoomId: 'R1', otaRatePlanId: 'RP1', date: '2026-07-01', rate: 120, currency: 'USD', restrictions: { cta: true, ctd: false, min_los: 2, max_los: 5 } };

// 1. provider codecs - Booking.com
test('Booking.com codec maps the neutral ARI update to its wire shape', () => {
  const w = bookingcom.encodeRateUpdate(RATE);
  assert.equal(w.hotel_id, 'H1');
  assert.equal(w.ari[0].room_id, 'R1');
  assert.equal(w.ari[0].rate.amount, 120);
  assert.equal(w.ari[0].restrictions.closed_to_arrival, true);
  assert.equal(w.ari[0].restrictions.min_length_of_stay, 2);
  assert.deepEqual(bookingcom.authToHeaders({ api_key: 'k' }), { 'X-Booking-Api-Key': 'k' });
});

// 2. provider codecs - Expedia (same architecture, different shape)
test('Expedia codec maps the neutral ARI update to its wire shape', () => {
  const w = expedia.encodeRateUpdate(RATE);
  assert.equal(w.resort_id, 'H1');
  assert.equal(w.roomTypes[0].ratePlans[0].schedule[0].rate, 120);
  assert.equal(w.roomTypes[0].ratePlans[0].schedule[0].cta, true);
  assert.equal(w.roomTypes[0].ratePlans[0].schedule[0].minStay, 2);
  assert.deepEqual(expedia.authToHeaders({ token: 't' }), { Authorization: 'Bearer t' });
});

// 3. ack decoding: 2xx ok, transport_disabled non-retryable, 4xx/5xx classification
test('decodeAck classifies success, disabled, and HTTP errors', () => {
  assert.equal(bookingcom.decodeAck('op', { ok: true, status: 200, body: { confirmation_id: 'C9' } }).ackId, 'C9');
  const disabled = bookingcom.decodeAck('op', { error: 'transport_disabled' });
  assert.equal(disabled.ok, false); assert.equal(disabled.retryable, false);
  assert.equal(bookingcom.decodeAck('op', { ok: false, status: 429 }).retryable, true);  // rate limited
  assert.equal(bookingcom.decodeAck('op', { ok: false, status: 503 }).retryable, true);  // server
  assert.equal(bookingcom.decodeAck('op', { ok: false, status: 401 }).retryable, false); // auth
});

// 4. transport default-disabled => no network, no retry
test('transport is disabled by default (no live call)', async () => {
  const t = buildOtaTransport({ provider: bookingcom, retryPolicy: fastRetry, sleep: noSleep });
  const ack = await t.pushRateUpdate(RATE);
  assert.equal(ack.ok, false);
  assert.equal(ack.errors[0].code, 'transport_disabled');
  assert.equal(ack.attempts, 1);
  assert.equal(t.httpEnabled, false);
});

// 5. retry on retryable failure then success; attempts counted
test('transport retries a 429 then succeeds', async () => {
  const http = fakeHttp([{ ok: false, status: 429 }, { ok: true, status: 200, body: { confirmation_id: 'OK1' } }]);
  const t = buildOtaTransport({ provider: bookingcom, http, retryPolicy: fastRetry, sleep: noSleep });
  const ack = await t.pushRateUpdate(RATE);
  assert.equal(ack.ok, true);
  assert.equal(ack.ackId, 'OK1');
  assert.equal(ack.attempts, 2);
});

// 6. no retry on a permanent 401
test('transport does not retry a permanent 401', async () => {
  const http = fakeHttp([{ ok: false, status: 401 }]);
  const t = buildOtaTransport({ provider: bookingcom, http, retryPolicy: fastRetry, sleep: noSleep });
  const ack = await t.pushRateUpdate(RATE);
  assert.equal(ack.ok, false);
  assert.equal(ack.attempts, 1);
  assert.equal(ack.status, 401);
});

// 7. auth headers resolved per call and passed to the transport
test('transport resolves auth headers and sends them', async () => {
  const http = fakeHttp([{ ok: true, status: 200, body: {} }]);
  const auth = { getAuthHeaders: async () => ({ 'X-Booking-Api-Key': 'secret-k' }) };
  const t = buildOtaTransport({ provider: bookingcom, http, auth, retryPolicy: fastRetry, sleep: noSleep });
  await t.pushAvailability({ hotelCode: 'H1', otaRoomId: 'R1', date: '2026-07-01', available: 3, stop_sell: false });
  assert.equal(http.sent[0].headers['X-Booking-Api-Key'], 'secret-k');
});

// 8. rate limiter enforces the min interval
test('rate limiter waits the min interval on the second call', async () => {
  const waited = [];
  const rl = buildRateLimiter({ minIntervalMs: 1000, clock: () => 1000, sleep: (ms) => { waited.push(ms); return Promise.resolve(); } });
  await rl.gate(); await rl.gate();
  assert.ok(waited.includes(1000));
});

// 9. reconciliation: drift + recommendations + determinism
test('reconcile detects inventory/rate/reservation drift with recommendations', () => {
  const local = {
    inventory: [{ key: 'rt|2026-07-01', available: 5, stopSell: false }, { key: 'rt|2026-07-02', available: 3, stopSell: false }],
    rates: [{ key: 'rp|2026-07-01', rate: 100, currency: 'USD' }],
    reservations: [{ id: 'B1', status: 'CONFIRMED' }]
  };
  const remote = {
    inventory: [{ key: 'rt|2026-07-01', available: 4, stopSell: false }],                 // mismatch + missing_remote
    rates: [{ key: 'rp|2026-07-01', rate: 100, currency: 'USD' }],                         // equal
    reservations: [{ id: 'B1', status: 'CONFIRMED' }, { id: 'B2', status: 'CONFIRMED' }]   // B2 missing_local
  };
  const a = reconcile({ channel: 'BOOKING_COM', local, remote });
  const b = reconcile({ channel: 'BOOKING_COM', local, remote });
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'deterministic');
  assert.equal(a.counts.inventory, 2);   // mismatch + missing_remote
  assert.equal(a.counts.rate, 0);
  assert.equal(a.counts.reservation, 1); // B2
  assert.ok(a.recommendations.some((r) => r.action === 'push_inventory'));
  assert.ok(a.recommendations.some((r) => r.action === 'resync_inventory'));
  assert.ok(a.recommendations.some((r) => r.action === 'ingest_reservation'));
});

// 10. monitoring: metrics + health escalation
test('sync monitor aggregates metrics and escalates health', async () => {
  const mon = buildSyncMonitor({ clock: () => 1000 });
  await mon.recordAttempt({ tenant_id: 't', channel: 'BOOKING_COM', op: 'pushRateUpdate', ok: true, attempts: 2 });
  assert.equal(mon.health('BOOKING_COM').status, 'healthy');
  await mon.recordAttempt({ tenant_id: 't', channel: 'BOOKING_COM', op: 'pushRateUpdate', ok: false, attempts: 1, errorCode: 'http_503' });
  assert.equal(mon.health('BOOKING_COM').status, 'degraded');
  await mon.recordAttempt({ tenant_id: 't', channel: 'BOOKING_COM', op: 'pushRateUpdate', ok: false });
  await mon.recordAttempt({ tenant_id: 't', channel: 'BOOKING_COM', op: 'pushRateUpdate', ok: false });
  assert.equal(mon.health('BOOKING_COM').status, 'down');
  const mtr = mon.metrics('BOOKING_COM');
  assert.equal(mtr.total, 4); assert.equal(mtr.ok, 1); assert.equal(mtr.failed, 3); assert.equal(mtr.retries, 1);
  assert.equal(mon.dlqVisibility([{ channel: 'BOOKING_COM' }, { channel: 'EXPEDIA' }]).byChannel.BOOKING_COM, 1);
});

// 11. provider registry
test('provider registry resolves known channels and rejects unknown', () => {
  // Phase 50 extended to 7 OTA providers (QYRVIA_CONNECT uses InProcessTransport — no HTTP codec).
  const list = providers.listProviders();
  assert.ok(list.includes('BOOKING_COM'));
  assert.ok(list.includes('EXPEDIA'));
  assert.ok(list.includes('AGODA'));
  assert.ok(list.includes('AIRBNB'));
  assert.ok(list.includes('MAKEMYTRIP'));
  assert.ok(list.includes('GOOGLE'));
  assert.ok(list.includes('TRIPADVISOR'));
  assert.ok(list.length >= 7);
  assert.equal(providers.hasProvider('QYRVIA_CONNECT'), false);
  assert.throws(() => providers.getProvider('QYRVIA_CONNECT'), /no transport provider/);
});
