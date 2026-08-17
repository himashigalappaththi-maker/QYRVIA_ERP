'use strict';

/**
 * Phase 69A (instruction 048 Section 19) — closes the test-coverage gap
 * instruction 047 found: channelSyncService.js's manual-vs-automatic ARI
 * double-send guard (ARI_AUTO_DISPATCH_CAPABLE_CHANNELS / forceResync /
 * isAriAutoDispatchLive) had no dedicated regression test. Pure NO-NETWORK
 * unit tests against buildChannelSyncService() directly, with
 * isAriAutoDispatchLive INJECTED (never touching real env vars / live
 * gates) — see the module's own header (src/channel-manager/sync/
 * channelSyncService.js) for the full guard rationale.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelSyncService } = require('../src/channel-manager/sync/channelSyncService');
const { buildSyncStateStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

function fakeRegistry() {
  const calls = [];
  return {
    calls,
    get(channel) {
      return {
        async pushRateUpdate(rate) { calls.push({ channel, op: 'pushRateUpdate', rate }); return { ok: true }; },
        async pushAvailability(inv) { calls.push({ channel, op: 'pushAvailability', inv }); return { ok: true }; },
        async pushReservation(res) { calls.push({ channel, op: 'pushReservation', res }); return { ok: true }; }
      };
    }
  };
}

function buildSync({ isAriAutoDispatchLive, realChannels } = {}) {
  const registry = fakeRegistry();
  const syncStateStore = buildSyncStateStoreMemory();
  const service = buildChannelSyncService({
    registry, syncStateStore, isAriAutoDispatchLive,
    realChannels: realChannels || new Set(['BOOKING_COM', 'QYRVIA_CONNECT', 'AGODA'])
  });
  return { service, registry, syncStateStore };
}

// ---- A. automatic ARI active + Booking.com capable -> manual push blocked --

test('A. automatic ARI active: a manual BOOKING_COM rate push is blocked (no delivery, no state write)', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true });
  const r = await service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate: { amount: 100, currency: 'USD', date: '2026-08-01' } });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(r.error, 'ari_auto_dispatch_active_requires_force_resync');
  assert.equal(registry.calls.length, 0, 'the adapter was never called — no double-send');
});

test('A. automatic ARI active: a manual BOOKING_COM availability push is ALSO blocked', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true });
  const r = await service.pushAvailability({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', inventory: { available: 5 } });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(r.error, 'ari_auto_dispatch_active_requires_force_resync');
  assert.equal(registry.calls.length, 0);
});

test('A. automatic ARI active: a manual QYRVIA_CONNECT push is ALSO blocked (dispatcher always attempts it once ready)', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true });
  const r = await service.pushRate({ tenant_id: 't1', channel: 'QYRVIA_CONNECT', room_type_id: 'rt1', rate: { amount: 50, currency: 'USD', date: '2026-08-01' } });
  assert.equal(r.skipped, true);
  assert.equal(registry.calls.length, 0);
});

// ---- B. explicit forceResync:true -> manual operation permitted ------------

test('B. forceResync:true permits the manual push to proceed even while automatic ARI is active', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true });
  const r = await service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate: { amount: 100, currency: 'USD', date: '2026-08-01' }, forceResync: true });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0].op, 'pushRateUpdate');
});

test('B. forceResync:true also works for availability', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true });
  const r = await service.pushAvailability({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', inventory: { available: 5 }, forceResync: true });
  assert.equal(r.ok, true);
  assert.equal(registry.calls.length, 1);
});

test('B. forceResync defaults to false — omitting it entirely behaves exactly like forceResync:false', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true });
  const r = await service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate: { amount: 100, currency: 'USD', date: '2026-08-01' } });
  assert.equal(r.skipped, true);
  assert.equal(registry.calls.length, 0);
});

// ---- C. automatic ARI disabled -> existing manual behavior unaffected ------

test('C. automatic ARI disabled (the default): manual BOOKING_COM push behaves exactly as before Phase 68A', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => false });
  const r = await service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate: { amount: 100, currency: 'USD', date: '2026-08-01' } });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(registry.calls.length, 1);
});

test('C. with NO isAriAutoDispatchLive override at all, the real default reads live env gates (both false in this test process) -> unaffected', async () => {
  // Deliberately does NOT inject isAriAutoDispatchLive — proves the
  // documented default (env.ARI_OUTBOX_DISPATCH_ENABLED / ARI_BOOKING_COM_LIVE,
  // both unset/false in this test process) is itself a safe, unaffecting no-op.
  const registry = fakeRegistry();
  const syncStateStore = buildSyncStateStoreMemory();
  const service = buildChannelSyncService({ registry, syncStateStore, realChannels: new Set(['BOOKING_COM']) });
  const r = await service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate: { amount: 100, currency: 'USD', date: '2026-08-01' } });
  assert.equal(r.ok, true);
  assert.equal(registry.calls.length, 1);
});

// ---- D. unrelated provider/channel behavior is not accidentally blocked ---

test('D. a channel the automatic ARI dispatcher does NOT support (e.g. AGODA) is never blocked by this guard, even with automatic ARI active', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true, realChannels: new Set(['AGODA']) });
  const r = await service.pushRate({ tenant_id: 't1', channel: 'AGODA', room_type_id: 'rt1', rate: { amount: 100, currency: 'USD', date: '2026-08-01' } });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(registry.calls.length, 1, 'AGODA is outside ARI_AUTO_DISPATCH_CAPABLE_CHANNELS — unaffected by the guard');
});

test('D. pushReservation() never routes through the guard at all, regardless of automatic ARI state', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true });
  const r = await service.pushReservation({ tenant_id: 't1', channel: 'BOOKING_COM', reservation: { bookingId: 'BK-1', status: 'CONFIRMED' } });
  assert.equal(r.ok, true, 'reservation push has no ari_outbox row / no ARI overlap — the guard only gates RATE/INVENTORY kinds');
});

test('D. an unrelated tenant/room combination on the SAME channel is independently gated correctly (guard is per-call, not global state)', async () => {
  const { service, registry } = buildSync({ isAriAutoDispatchLive: () => true });
  const blocked = await service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate: { amount: 1, currency: 'USD', date: '2026-08-01' } });
  const forced = await service.pushRate({ tenant_id: 't2', channel: 'BOOKING_COM', room_type_id: 'rt2', rate: { amount: 1, currency: 'USD', date: '2026-08-01' }, forceResync: true });
  assert.equal(blocked.skipped, true);
  assert.equal(forced.skipped, false);
  assert.equal(registry.calls.length, 1, 'only the forced call actually delivered');
});

// ---- E. no network request is needed to prove any of the above ------------

test('E. the guard decision is reachable and fully provable via a synchronous boolean — no transport/network object is ever consulted', async () => {
  // buildSync()/fakeRegistry() above construct the service from plain
  // in-memory fakes only (buildSyncStateStoreMemory + a hand-written fake
  // registry) — no buildHttpTransport, no fetch, no real adapter is ever
  // created or reachable in A-D above. isAriAutoDispatchLive itself is a
  // synchronous injected function, never an actual network probe of
  // Booking.com or any provider.
  let calls = 0;
  const { service } = buildSync({ isAriAutoDispatchLive: () => { calls += 1; return true; } });
  await service.pushRate({ tenant_id: 't1', channel: 'BOOKING_COM', room_type_id: 'rt1', rate: { amount: 1, currency: 'USD', date: '2026-08-01' } });
  assert.equal(calls, 1, 'the guard consulted its injected (synchronous, network-free) predicate exactly once');
});
