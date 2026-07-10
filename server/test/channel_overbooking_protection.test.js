'use strict';

/**
 * Phase 53 H1 — Overbooking protection: ARI availability gate before OTA booking import.
 * Uses memory stores and fake implementations only; no live DB.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelInboundService } = require('../src/channel-manager/inbound/channelInboundService');
const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

function fakeCommandBus() {
  const dispatched = [];
  let n = 0;
  return {
    dispatched,
    async dispatch(name, input, ctx) {
      dispatched.push({ name, input });
      return { ok: true, result: { id: 'res-' + (++n) } };
    }
  };
}

function booking(id, status = 'CONFIRMED') {
  return {
    bookingId: id, channel: 'BOOKING_COM', status,
    externalRef: id, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03',
    guestName: 'Test Guest'
  };
}

// ── 1. Provider returns 0 → CONFLICT ──────────────────────────────────────────

test('availabilityProvider returns 0: result is CONFLICT, booking store has CONFLICT status', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: bus,
    availabilityProvider: async () => 0
  });

  const r = await svc.ingest(booking('B-AVAIL-1'), { ctx: CTX });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_availability');
  assert.equal(r.status, 'CONFLICT');

  // Booking store should have the row with CONFLICT status
  const row = store.getByExternalRef('t1', 'BOOKING_COM', 'B-AVAIL-1', 'p1');
  assert.ok(row, 'booking should be stored even on conflict');
  assert.equal(row.status, 'CONFLICT');
  assert.equal(row.conflict_reason, 'no_availability');

  // PMS command must NOT be dispatched
  assert.equal(bus.dispatched.length, 0, 'no PMS dispatch on conflict');
});

// ── 2. Provider returns 2 → proceeds normally ─────────────────────────────────

test('availabilityProvider returns 2: booking proceeds normally', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: bus,
    availabilityProvider: async () => 2
  });

  const r = await svc.ingest(booking('B-AVAIL-2'), { ctx: CTX });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
  assert.equal(bus.dispatched.length, 1);
  assert.equal(bus.dispatched[0].name, 'pms.reservation.create');
});

// ── 3. No availabilityProvider → backward compat ─────────────────────────────

test('no availabilityProvider injected: proceeds without availability check (backward compat)', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: bus });

  const r = await svc.ingest(booking('B-AVAIL-3'), { ctx: CTX });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
  assert.equal(bus.dispatched.length, 1);
});

// ── 4. Provider throws → fail-closed (treated as 0) ──────────────────────────

test('availabilityProvider throws: fail-closed, result is CONFLICT', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: bus,
    availabilityProvider: async () => { throw new Error('ARI service down'); }
  });

  const r = await svc.ingest(booking('B-AVAIL-4'), { ctx: CTX });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_availability');
  assert.equal(r.status, 'CONFLICT');
  assert.equal(bus.dispatched.length, 0, 'no PMS dispatch when provider throws');
});

// ── 5. Concurrent bookings: first succeeds, second gets CONFLICT ──────────────

test('two concurrent OTA bookings for same room/dates when only 1 available: first succeeds, second CONFLICT', async () => {
  const store = buildBookingStoreMemory();
  let available = 1;
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: fakeCommandBus(),
    availabilityProvider: async () => {
      const current = available;
      available = Math.max(0, available - 1); // decrement on each call
      return current;
    }
  });

  const b1 = booking('B-CONC-1');
  const b2 = booking('B-CONC-2'); // different booking id, same room/dates

  const [r1, r2] = await Promise.all([
    svc.ingest(b1, { ctx: CTX }),
    svc.ingest(b2, { ctx: CTX })
  ]);

  // One must succeed and one must be CONFLICT
  const results = [r1, r2];
  const successes = results.filter((r) => r.ok === true);
  const conflicts = results.filter((r) => r.ok === false && r.error === 'no_availability');

  assert.equal(successes.length, 1, 'exactly one booking should succeed');
  assert.equal(conflicts.length, 1, 'exactly one booking should be CONFLICT');
});
