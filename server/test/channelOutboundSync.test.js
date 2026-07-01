'use strict';

/** Phase 24 B8-B3 - real QTCN outbound sync (in-process), delta, per-channel gating, no network. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelOutboundSync } = require('../src/channel-manager/sync');
const { buildInProcessTransport, buildHttpTransport } = require('../src/channel-manager/transport/transport');
const { TransportOTAAdapter } = require('../src/channel-manager/adapters/framework/TransportOTAAdapter');
const { validator } = require('../src/channel-manager/adapters/framework');

const base = (channel, hash) => ({ tenant_id: 't1', property_id: 'p1', channel, room_type_id: 'rt1', rate: { amount: hash, currency: 'USD', date: '2026-07-01' } });

// ---- real QTCN delivery (in-process, no network) --------------------------
test('QTCN rate push delivers via in-process transport + records sync_state', async () => {
  const sync = buildChannelOutboundSync({ mode: 'memory' });
  const r = await sync.service.pushRate(base('QTCN', 100));
  assert.equal(r.ok, true);
  assert.equal(r.real, true);
  assert.equal(r.skipped, false);
  // delivered to the in-process sink
  assert.equal(sync.transports.inproc.deliveries.length, 1);
  assert.equal(sync.transports.inproc.deliveries[0].op, 'pushRateUpdate');
  // sync_state recorded
  const st = sync.syncStateStore.get('t1', 'QTCN', r.resource_key);
  assert.equal(st.last_status, 'OK');
  assert.ok(st.last_hash && st.last_sync_at);
});

// ---- delta detection -------------------------------------------------------
test('delta: unchanged rate is skipped; changed rate delivers again', async () => {
  const sync = buildChannelOutboundSync({ mode: 'memory' });
  await sync.service.pushRate(base('QTCN', 100));
  const again = await sync.service.pushRate(base('QTCN', 100));      // same hash
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'no_delta');
  assert.equal(sync.transports.inproc.deliveries.length, 1);        // no extra delivery

  const changed = await sync.service.pushRate(base('QTCN', 250));    // new amount
  assert.equal(changed.skipped, false);
  assert.equal(sync.transports.inproc.deliveries.length, 2);
});

// ---- availability ----------------------------------------------------------
test('QTCN availability push delivers + records INVENTORY sync_state', async () => {
  const sync = buildChannelOutboundSync({ mode: 'memory' });
  const r = await sync.service.pushAvailability({ tenant_id: 't1', channel: 'QTCN', room_type_id: 'rt1', inventory: { available: 5, minLos: 1, maxLos: 7 } });
  assert.equal(r.ok, true);
  assert.equal(sync.transports.inproc.deliveries[0].op, 'pushAvailability');
  assert.ok(r.resource_key.includes('INVENTORY'));
});

// ---- per-channel gating ----------------------------------------------------
test('non-real channel (Booking.com) does NOT deliver to QTCN transport; still records state', async () => {
  const sync = buildChannelOutboundSync({ mode: 'memory', realChannels: new Set(['QTCN']) });
  const r = await sync.service.pushRate(base('BOOKING_COM', 100));
  assert.equal(r.real, false);
  assert.equal(sync.transports.inproc.deliveries.length, 0); // no real delivery for a non-real channel
  const st = sync.syncStateStore.get('t1', 'BOOKING_COM', r.resource_key);
  assert.ok(st, 'sync_state still recorded for observability');
});

// ---- HTTP transport disabled (no external network) ------------------------
test('HttpTransport refuses to send when disabled (default): no network', async () => {
  const http = buildHttpTransport({});                  // enabled:false by default
  const res = await http.send({ endpoint: 'https://example.test', payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'transport_disabled');
  // enabled path uses an injected fetch (never a real network in tests)
  let called = false;
  const http2 = buildHttpTransport({ enabled: true, fetchImpl: async () => { called = true; return { ok: true, status: 200 }; } });
  const res2 = await http2.send({ endpoint: 'https://example.test', payload: {} });
  assert.equal(res2.ok, true);
  assert.equal(called, true);
});

// ---- in-process transport is network-free ----------------------------------
test('InProcessTransport records deliveries with no network primitives', async () => {
  const t = buildInProcessTransport();
  const ack = await t.send({ channel: 'QTCN', op: 'pushRateUpdate', payload: { amount: 1 } });
  assert.equal(ack.ok, true);
  assert.equal(t.deliveries.length, 1);
  assert.equal((await t.health()).ok, true);
});

// ---- adapter compliance + health ------------------------------------------
test('TransportOTAAdapter satisfies the canonical contract and reports health', async () => {
  const a = new TransportOTAAdapter({ channel: 'QTCN', transport: buildInProcessTransport() });
  assert.equal(validator.validateInterface(a).ok, true);
  const h = await a.health();
  assert.equal(h.ok, true);
  assert.equal(h.transport, 'in-process');
  const norm = a.normalizeBooking({ id: 'B1', status: 'CONFIRMED' });
  assert.equal(norm.bookingId, 'B1');
  assert.equal(norm.channel, 'QTCN');
});

// ---- audit safety ----------------------------------------------------------
test('sync audit events carry metadata only', async () => {
  const audits = [];
  const sync = buildChannelOutboundSync({ mode: 'memory', onAudit: (e) => audits.push(e) });
  await sync.service.pushRate(base('QTCN', 100));
  assert.equal(audits[0].type, 'channel.rate_pushed');
  assert.equal(audits[0].channel, 'QTCN');
  assert.equal(audits[0].real, true);
  assert.equal(audits[0].status, 'OK');
  // no payload/secret
  assert.equal(audits[0].rate, undefined);
  assert.equal(audits[0].credentials_ref, undefined);
});

// ---- realChannels resolution from env default -----------------------------
test('default realChannels resolves to QTCN', () => {
  const sync = buildChannelOutboundSync({ mode: 'memory' });
  assert.equal(sync.realChannels.has('QTCN'), true);
  assert.equal(sync.service.isReal('QTCN'), true);
  assert.equal(sync.service.isReal('BOOKING_COM'), false);
});
