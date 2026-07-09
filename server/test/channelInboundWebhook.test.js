'use strict';

/** Phase 24 B8-B4 - inbound webhook: signature, idempotent ingest, PMS dispatch, route gating. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sign, verify } = require('../src/channel-manager/inbound/webhookVerifier');
const { buildChannelInboundService } = require('../src/channel-manager/inbound/channelInboundService');
const { buildWebhookIngress } = require('../src/channel-manager/inbound/webhookIngress');
const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

function fakeCommandBus() {
  const dispatched = [];
  let n = 0;
  return {
    dispatched,
    async dispatch(name, input, ctx) { dispatched.push({ name, input }); return { ok: true, result: { id: 'res-' + (++n) } }; }
  };
}
function failingCommandBus() { return { async dispatch() { return { ok: false, error: 'business_date_locked' }; } }; }

const booking = (id, status, extra = {}) => Object.assign({ bookingId: id, channel: 'QYRVIA_CONNECT', status, externalRef: id, roomTypeId: 'rt1', arrival: '2026-07-01', departure: '2026-07-03', guestName: 'A' }, extra);

// ---- signature verification ------------------------------------------------
test('verifier: valid HMAC passes, tampered fails', () => {
  const secret = 'whsec_123';
  const payload = { bookings: [{ id: 'B1' }] };
  const s = sign(secret, payload);
  assert.equal(verify({ secret, payload, signature: s }), true);
  assert.equal(verify({ secret, payload: { bookings: [{ id: 'B2' }] }, signature: s }), false);
  assert.equal(verify({ secret, payload, signature: 'deadbeef' }), false);
  assert.equal(verify({ secret: '', payload, signature: s }), false);
});

// ---- create -> commandBus dispatch + pms link -----------------------------
test('ingest create: dispatches pms.reservation.create and links pms_reservation_id', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: bus });
  const r = await svc.ingest(booking('B1', 'CONFIRMED'), { ctx: CTX });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
  assert.equal(bus.dispatched[0].name, 'pms.reservation.create');
  assert.equal(bus.dispatched[0].input.external_ref, 'B1');
  assert.equal(r.pms_reservation_id, 'res-1');
  assert.equal(store.getByExternalRef('t1', 'QYRVIA_CONNECT', 'B1').pms_reservation_id, 'res-1');
});

// ---- idempotency: duplicate + stale ---------------------------------------
test('ingest idempotency: same status deduped; lower rank stale; advance updates', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: bus });
  await svc.ingest(booking('B1', 'CONFIRMED'), { ctx: CTX });
  const dup = await svc.ingest(booking('B1', 'CONFIRMED'), { ctx: CTX });
  assert.equal(dup.deduped, true);
  const stale = await svc.ingest(booking('B1', 'PENDING'), { ctx: CTX }); // lower rank
  assert.equal(stale.deduped, true);
  assert.equal(bus.dispatched.length, 1, 'no extra PMS dispatch for dup/stale');

  const adv = await svc.ingest(booking('B1', 'CHECKED_IN'), { ctx: CTX }); // advance
  assert.equal(adv.ok, true);
  assert.equal(adv.action, 'update');                                      // existing link => update
  assert.equal(bus.dispatched[1].name, 'pms.reservation.update');
  assert.equal(bus.dispatched[1].input.reservation_id, 'res-1');
});

// ---- cancel-after-presence exception --------------------------------------
test('ingest cancel after CHECKED_IN is rejected as an exception (no mutation)', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: bus });
  await svc.ingest(booking('B1', 'CONFIRMED'), { ctx: CTX });
  await svc.ingest(booking('B1', 'CHECKED_IN'), { ctx: CTX });
  const cancel = await svc.ingest(booking('B1', 'CANCELLED'), { ctx: CTX });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.exception, true);
  assert.equal(cancel.error, 'cannot_cancel_present');
  assert.equal(store.getByExternalRef('t1', 'QYRVIA_CONNECT', 'B1').status, 'CHECKED_IN'); // unchanged
});

// ---- command failure -> link pending --------------------------------------
test('ingest with PMS command failure retains booking as link-pending (no duplicate)', async () => {
  const store = buildBookingStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: failingCommandBus() });
  const r = await svc.ingest(booking('B9', 'CONFIRMED'), { ctx: CTX });
  assert.equal(r.ok, false);
  assert.equal(r.link_pending, true);
  assert.equal(r.error, 'business_date_locked');
  const row = store.getByExternalRef('t1', 'QYRVIA_CONNECT', 'B9');
  assert.equal(row.pms_reservation_id, null);
});

// ---- ingress: signature + adapter normalization ---------------------------
function fakeAdapter() {
  return { channel: 'QYRVIA_CONNECT', handleWebhook: (req) => ({ verified: true, events: (req.bookings || []).map((b) => booking(b.id, b.status || 'CONFIRMED')) }) };
}
function fakeRegistry(adapter) { return { get: (c) => { if (c !== adapter.channel) throw new Error('unknown'); return adapter; } }; }

test('ingress: valid signature ingests; invalid signature 401; unknown channel 404', async () => {
  const store = buildBookingStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: fakeCommandBus() });
  const ingress = buildWebhookIngress({ registry: fakeRegistry(fakeAdapter()), inboundService: svc, resolveSecret: async () => 'whsec' });
  const body = { bookings: [{ id: 'B1', status: 'CONFIRMED' }] };

  const good = await ingress.handle({ channel: 'QYRVIA_CONNECT', body, signature: sign('whsec', body), ctx: CTX });
  assert.equal(good.ok, true);
  assert.equal(good.status, 200);
  assert.equal(good.ingested[0].ok, true);

  const bad = await ingress.handle({ channel: 'QYRVIA_CONNECT', body, signature: 'bad', ctx: CTX });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  assert.equal(bad.error, 'invalid_signature');

  const unknown = await ingress.handle({ channel: 'NOPE', body, signature: sign('whsec', body), ctx: CTX });
  assert.equal(unknown.status, 404);
});

test('ingress: no secret configured + signature not required => ingests', async () => {
  const store = buildBookingStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: fakeCommandBus() });
  const ingress = buildWebhookIngress({ registry: fakeRegistry(fakeAdapter()), inboundService: svc, resolveSecret: async () => null });
  const out = await ingress.handle({ channel: 'QYRVIA_CONNECT', body: { bookings: [{ id: 'B1' }] }, ctx: CTX });
  assert.equal(out.ok, true);
});

// ---- audit safety ----------------------------------------------------------
test('inbound audit carries metadata only (no guest/payload secrets)', async () => {
  const audits = [];
  const store = buildBookingStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: fakeCommandBus(), onAudit: (e) => audits.push(e) });
  await svc.ingest(booking('B1', 'CONFIRMED', { guestName: 'SENSITIVE NAME' }), { ctx: CTX });
  const ing = audits.find((a) => a.type === 'channel.booking_ingested');
  assert.ok(ing);
  assert.ok(!JSON.stringify(audits).includes('SENSITIVE NAME'));
});

// ---- route gating ----------------------------------------------------------
test('webhook route is gated: absent when disabled, present when enabled', () => {
  function loadRoutes(flag) {
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/channel-manager/api/channel.routes')];
    if (flag === undefined) delete process.env.CHANNEL_WEBHOOK_ENABLED; else process.env.CHANNEL_WEBHOOK_ENABLED = flag;
    return require('../src/channel-manager/api/channel.routes');
  }
  const deps = { channelManager: { status: () => ({}) }, channelInbound: { ingress: { handle: async () => ({ ok: true }) } } };
  const hasWebhook = (router) => router.stack.some((l) => l.route && l.route.path === '/webhook/:channel');

  const off = loadRoutes('false').build(deps);
  assert.equal(hasWebhook(off), false, 'route absent when disabled');
  const on = loadRoutes('true').build(deps);
  assert.equal(hasWebhook(on), true, 'route present when enabled');
  loadRoutes(undefined); // restore default
});
