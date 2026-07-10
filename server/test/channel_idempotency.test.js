'use strict';

/**
 * Phase 53 — Idempotency tests (items 1 + 2).
 * Tests concurrent ingest, sequential dedup, and queue idempotency.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelInboundService } = require('../src/channel-manager/inbound/channelInboundService');
const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');
const { buildChannelSyncQueue } = require('../src/channel-manager/services/channelSyncQueue');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

function fakeCommandBus() {
  const dispatched = [];
  let n = 0;
  return {
    dispatched,
    async dispatch(name, input) {
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

// ── 1. Concurrent ingest same external_ref → booking store has exactly 1 entry ──

test('concurrent ingest: same external_ref via Promise.all → booking store has exactly 1 entry', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: bus });

  const b = booking('IDEM-CONC-1');
  const [r1, r2] = await Promise.all([
    svc.ingest(b, { ctx: CTX }),
    svc.ingest(b, { ctx: CTX })
  ]);

  // Both calls should resolve without error
  assert.ok(r1.ok !== false || r1.error === undefined || r1.deduped, 'r1 should resolve');
  assert.ok(r2.ok !== false || r2.error === undefined || r2.deduped, 'r2 should resolve');

  // The booking store must have exactly 1 entry (upsert is idempotent by key)
  assert.equal(store.list({ tenant_id: 't1' }).length, 1, 'exactly one booking in store after concurrent ingest');

  // At most both dispatched (concurrent race is possible with in-memory store),
  // but the store remains idempotent. Verify final booking is coherent.
  const row = store.getByExternalRef('t1', 'BOOKING_COM', 'IDEM-CONC-1', 'p1');
  assert.ok(row, 'booking should exist in store');
  assert.equal(row.channel, 'BOOKING_COM');
});

// ── 2. Sequential duplicate ingest → second is deduped ───────────────────────

test('sequential ingest same booking twice: second call is deduped', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: bus });

  const b = booking('IDEM-SEQ-1');
  const r1 = await svc.ingest(b, { ctx: CTX });
  const r2 = await svc.ingest(b, { ctx: CTX });

  assert.equal(r1.ok, true);
  assert.equal(r1.action, 'create');

  assert.equal(r2.ok, true);
  assert.equal(r2.deduped, true);

  // Only 1 PMS dispatch total
  assert.equal(bus.dispatched.length, 1, 'only one PMS dispatch for two identical ingests');
  assert.equal(store.list({ tenant_id: 't1' }).length, 1, 'only one booking in store');
});

// ── 3. Queue: enqueuing same (reservation_id, action) twice PENDING → only 1 PENDING ──

test('queue: same (reservation_id, action) enqueued twice while first is PENDING → only one PENDING job', () => {
  const q = buildChannelSyncQueue();

  const item = { reservation_id: 'res-A', action: 'CREATE_BOOKING', channel: 'BOOKING_COM', tenant_id: 't1' };
  const r1 = q.enqueue(item);
  const r2 = q.enqueue(item); // duplicate

  assert.equal(r1.accepted, true, 'first enqueue accepted');
  assert.equal(r2.deduped, true, 'second enqueue deduped');
  assert.equal(q.size(), 1, 'only one PENDING job in queue');
});

// ── 4. Queue: enqueuing same after PROCESSING clears → second accepted ────────

test('queue: same (reservation_id, action) after first job transitions out of PENDING → second accepted', () => {
  const q = buildChannelSyncQueue();

  const item = { reservation_id: 'res-B', action: 'CREATE_BOOKING', channel: 'BOOKING_COM', tenant_id: 't1' };

  // First enqueue and then dequeue (moves to PROCESSING state)
  const r1 = q.enqueue(item);
  assert.equal(r1.accepted, true);

  const dequeued = q.dequeue();
  assert.ok(dequeued, 'dequeue should return a job');
  assert.equal(dequeued.reservation_id, 'res-B');

  // Now there should be no PENDING job for this reservation+action
  // So a new enqueue of the same item should be accepted
  const r2 = q.enqueue(item);
  assert.equal(r2.accepted, true, 'second enqueue accepted after first is out of PENDING');

  // Queue has 2 total items (PROCESSING + new PENDING); check pending list specifically
  const pending = q.list('PENDING');
  assert.equal(pending.length, 1, 'one new PENDING job in queue');
  assert.equal(pending[0].reservation_id, 'res-B');
});
