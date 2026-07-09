'use strict';

/**
 * Phase 28 - Channel Manager Core migration to the canonical adapter registry.
 *
 * Validates that the core is backed by the canonical framework registry, that
 * legacy adapters are auto-bridged with identical behavior, that pure-canonical
 * adapters can be registered + orchestrated, that the public status shape is
 * preserved, and that CHANNEL_CANONICAL_CORE=false restores the legacy path.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ChannelManagerCore } = require('../src/channel-manager/core/ChannelManagerCore');
const { BookingComAdapter } = require('../src/channel-manager/adapters/bookingcom/BookingComAdapter');
const { CANONICAL_METHODS } = require('../src/channel-manager/adapters/framework/CanonicalOTAAdapter');
const { validateInterface } = require('../src/channel-manager/adapters/framework/adapterValidator');
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');

const CTX = { tenantId: 't-1', propertyId: 'p-1', requestId: 'rq' };
const silentBus = () => ({ emitted: [], emit(e) { this.emitted.push(e); return Promise.resolve(); } });

// A pure-canonical adapter test double (8-method contract, no legacy methods).
function fakeCanonicalAdapter(channel, { qyrvia_owned = false, commissionPct = 7 } = {}) {
  const calls = [];
  return {
    channel, auth: null, qyrvia_owned, commissionPct, calls,
    async init() {},
    async health() { return { ok: true }; },
    async close() {},
    normalizeBooking(raw) { return { bookingId: raw.id, channel, status: 'CONFIRMED' }; },
    async pushReservation(b) { calls.push(['pushReservation', b]); return { ok: true }; },
    async pushAvailability(i) { calls.push(['pushAvailability', i]); return { ok: true }; },
    async pushRateUpdate(r) { calls.push(['pushRateUpdate', r]); return { ok: true }; },
    handleWebhook() { return { verified: true, events: [] }; }
  };
}
const passthroughSync = () => { const cap = {}; return { cap, syncRate: async (a, r) => { cap.rate = { a, r }; return { ok: true }; }, syncInventory: async (a, i) => { cap.inv = { a, i }; return { ok: true }; } }; };
const idServices = { rateService: { validate: (x) => x }, inventoryService: { validate: (x) => x } };

// 1. canonical registry is the default backing
test('canonical mode is the default and auto-bridges a legacy adapter', () => {
  const core = new ChannelManagerCore({ eventBus: silentBus() });
  core.registerAdapter(new BookingComAdapter());
  const a = core.getAdapter(CHANNELS.BOOKING_COM);
  // the registered adapter is a canonical adapter (8-method contract), bridged from legacy
  assert.equal(validateInterface(a).ok, true);
  for (const m of CANONICAL_METHODS) assert.equal(typeof a[m], 'function');
  assert.ok(a._legacy, 'bridge retains the original legacy adapter');
  assert.deepEqual(core.listChannels(), [CHANNELS.BOOKING_COM]);
});

// 2. legacy behavior preserved through the bridge (pull + dedup ingestion)
test('legacy adapter ingestion behavior is preserved (created then deduped)', async () => {
  const core = new ChannelManagerCore({ eventBus: silentBus() });
  core.registerAdapter(new BookingComAdapter());
  const first = await core.syncBookings(CHANNELS.BOOKING_COM, CTX);
  const second = await core.syncBookings(CHANNELS.BOOKING_COM, CTX);
  assert.equal(first.pulled > 0, true);
  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.equal(second.deduped, 2);
});

// 3. pure-canonical adapter can be registered + orchestrated
test('pure-canonical adapter is registered and orchestrated via canonical methods', async () => {
  const fake = fakeCanonicalAdapter(CHANNELS.AGODA);
  const fakeSync = passthroughSync();
  const core = new ChannelManagerCore(Object.assign({ eventBus: silentBus(), syncEngine: fakeSync }, idServices));
  core.registerAdapter(fake);

  await core.pushRates(CHANNELS.AGODA, { amount: 100, currency: 'USD' }, CTX);
  await core.pushInventory(CHANNELS.AGODA, { available: 3 }, CTX);
  // SyncEngine received a legacy-shaped ops view whose pushRates delegates to canonical pushRateUpdate
  assert.equal(typeof fakeSync.cap.rate.a.pushRates, 'function');
  await fakeSync.cap.rate.a.pushRates({ amount: 100, currency: 'USD' });
  await fakeSync.cap.inv.a.pushInventory({ available: 3 });
  assert.ok(fake.calls.some((c) => c[0] === 'pushRateUpdate'));
  assert.ok(fake.calls.some((c) => c[0] === 'pushAvailability'));

  await core.confirmBooking(CHANNELS.AGODA, 'X1', CTX);
  await core.cancelBooking(CHANNELS.AGODA, 'X2', CTX);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'pushReservation' && c[1].bookingId === 'X1')[1], { bookingId: 'X1', status: 'CONFIRMED' });
  assert.deepEqual(fake.calls.find((c) => c[0] === 'pushReservation' && c[1].bookingId === 'X2')[1], { bookingId: 'X2', status: 'CANCELLED' });
});

// 4. booking-ingestion compatibility: legacy pulls, canonical-native pulls nothing
test('booking-ingestion compatibility: canonical-native adapter pulls nothing (webhook-driven)', async () => {
  const core = new ChannelManagerCore({ eventBus: silentBus() });
  core.registerAdapter(fakeCanonicalAdapter(CHANNELS.EXPEDIA));
  const out = await core.syncBookings(CHANNELS.EXPEDIA, CTX);
  assert.equal(out.pulled, 0);
  assert.equal(out.created, 0);
});

// 5. status() shape preserved across legacy + canonical adapters
test('status() preserves shape (qyrvia_owned/commissionPct, queue, bookings)', () => {
  const core = new ChannelManagerCore({ eventBus: silentBus() });
  core.registerAdapter(new BookingComAdapter());
  core.registerAdapter(fakeCanonicalAdapter(CHANNELS.AGODA, { qyrvia_owned: true, commissionPct: 12 }));
  const s = core.status();
  const bc = s.channels.find((c) => c.channel === CHANNELS.BOOKING_COM);
  const ag = s.channels.find((c) => c.channel === CHANNELS.AGODA);
  assert.deepEqual(bc, { channel: CHANNELS.BOOKING_COM, qyrvia_owned: false, commissionPct: null });
  assert.deepEqual(ag, { channel: CHANNELS.AGODA, qyrvia_owned: true, commissionPct: 12 });
  assert.deepEqual(Object.keys(s).sort(), ['bookings', 'channels', 'queue']);
  assert.equal(typeof s.queue.size, 'number');
  assert.equal(typeof s.bookings, 'number');
});

// 6. canonical registry rejects duplicate channels
test('duplicate channel registration is rejected in canonical mode', () => {
  const core = new ChannelManagerCore({ eventBus: silentBus() });
  core.registerAdapter(new BookingComAdapter());
  assert.throws(() => core.registerAdapter(new BookingComAdapter()), /duplicate channel/);
});

// 7. unknown channel lookup throws (parity with legacy)
test('getAdapter throws for an unregistered channel', () => {
  const core = new ChannelManagerCore({ eventBus: silentBus() });
  assert.throws(() => core.getAdapter('nope'), /no adapter registered/);
});

// 8. rollback path: legacy Map registry restores pre-migration behavior
test('rollback (canonicalRegistry:false) uses the legacy Map and the 6-method contract', async () => {
  const core = new ChannelManagerCore({ eventBus: silentBus(), canonicalRegistry: false });
  // a pure-canonical adapter lacks the legacy 6-method surface => rejected on the legacy path
  assert.throws(() => core.registerAdapter(fakeCanonicalAdapter(CHANNELS.AGODA)), /missing/);
  // legacy adapter works, behavior identical
  core.registerAdapter(new BookingComAdapter());
  const a = core.getAdapter(CHANNELS.BOOKING_COM);
  assert.equal(a._legacy, undefined);                 // stored raw (not bridged)
  assert.equal(typeof a.pullBookings, 'function');
  const out = await core.syncBookings(CHANNELS.BOOKING_COM, CTX);
  assert.equal(out.created, 2);
});
