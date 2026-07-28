'use strict';

/** Phase 24 S3 - Channel Sync Queue (in-memory) + subscriber enqueue integration. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelSyncQueue, STATUS } = require('../src/channel-manager/services/channelSyncQueue');
const { buildChannelMappingStore } = require('../src/channel-manager/services/channelMappingStore');
const { buildChannelSubscriber } = require('../src/channel-manager/services/channelSubscriber');

function fakeBus() {
  const handlers = new Map();
  return {
    subscribe(type, h) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(h);
      return () => handlers.get(type).delete(h);
    },
    async emit(event) { for (const h of (handlers.get(event.event_type) || [])) await h(event); }
  };
}
// Phase 65 C2: a real domain event carries the trusted envelope. The old fixture
// omitted tenant_id, which the spine now correctly refuses to enqueue without.
const ev = (type, rid, extra = {}) => ({
  event_type: type, event_id: 'ev-' + rid,
  aggregate_type: 'reservation', aggregate_id: rid,
  tenant_id: 't1', property_id: 'p1', actor_id: 'u1', request_id: 'rq1',
  occurred_at: '2026-06-24T10:00:00.000Z',
  payload: Object.assign({ reservation_id: rid }, extra)
});
// Phase 65 C1: the subscriber no longer invents a channel. The caller supplies
// the ENABLED mappings; with no resolver the spine fans out to nothing.
const resolveChannels = async () => ['BOOKING_COM'];

test('queue enqueue produces the documented item shape', () => {
  const q = buildChannelSyncQueue({ clock: () => 123, idGen: () => 'fixed-1' });
  // PHASE 65 C2 — DELIBERATE TEST INVERSION.
  //   OLD DEFECTIVE CONTRACT: the item shape carried no tenant/property/event
  //     identity, and the channel was the literal 'channel-manager'.
  //   NEW CORRECT CONTRACT: the job carries the trusted identity it needs to be
  //     processed at all, and a canonical channel code.
  //   JUSTIFYING PRODUCTION CHANGE: enqueue() in channelSyncQueue.js.
  const res = q.enqueue({
    tenant_id: 't1', property_id: 'p1', actor_id: 'u1', request_id: 'rq1',
    event_id: 'ev-1', event_type: 'reservation.created',
    aggregate_type: 'reservation', aggregate_id: 'r1',
    occurred_at: '2026-06-24T10:00:00.000Z',
    reservation_id: 'r1', action: 'CREATE_BOOKING', channel: 'BOOKING_COM', payload: { a: 1 }
  });
  assert.equal(res.accepted, true);
  assert.deepEqual(res.item, {
    id: 'fixed-1',
    tenant_id: 't1', property_id: 'p1', actor_id: 'u1', request_id: 'rq1',
    event_id: 'ev-1', event_type: 'reservation.created',
    aggregate_type: 'reservation', aggregate_id: 'r1',
    occurred_at: '2026-06-24T10:00:00.000Z',
    reservation_id: 'r1', action: 'CREATE_BOOKING',
    channel: 'BOOKING_COM', payload: { a: 1 }, status: 'PENDING', created_at: 123
  });
  assert.equal(q.size(), 1);
});

test('C3: the dedupe key includes the CHANNEL — fan-out is not collapsed', () => {
  // PHASE 65 C3. Before this, one event fanning out to eight channels produced
  // eight jobs that all collapsed onto `reservation_id::action`, so seven
  // channels were silently deduped away and never synced.
  const q = buildChannelSyncQueue();
  const base = { tenant_id: 't1', reservation_id: 'r1', action: 'CREATE_BOOKING' };
  assert.equal(q.enqueue({ ...base, channel: 'BOOKING_COM' }).accepted, true);
  assert.equal(q.enqueue({ ...base, channel: 'AGODA' }).accepted, true);
  assert.equal(q.enqueue({ ...base, channel: 'QYRVIA_CONNECT' }).accepted, true);
  assert.equal(q.size(), 3, 'one job per channel');
  // the SAME channel is still deduped while pending
  const dup = q.enqueue({ ...base, channel: 'AGODA' });
  assert.equal(dup.accepted, false);
  assert.equal(dup.deduped, true);
  // and a different tenant never collides with this one
  assert.equal(q.enqueue({ ...base, tenant_id: 't2', channel: 'AGODA' }).accepted, true);
});

test('dedupe: duplicate PENDING (reservation_id + action) is rejected', () => {
  const q = buildChannelSyncQueue();
  assert.equal(q.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING' }).accepted, true);
  const dup = q.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING' });
  assert.equal(dup.accepted, false);
  assert.equal(dup.deduped, true);
  assert.equal(q.size(), 1);
  // a different action for same reservation IS allowed
  assert.equal(q.enqueue({ reservation_id: 'r1', action: 'UPDATE_BOOKING' }).accepted, true);
  assert.equal(q.size(), 2);
});

test('state transitions: PENDING -> PROCESSING -> COMPLETED; dequeue is FIFO', () => {
  const q = buildChannelSyncQueue({ idGen: (() => { let n = 0; return () => 'q' + (++n); })() });
  const a = q.enqueue({ reservation_id: 'rA', action: 'CREATE_BOOKING' }).item;
  const b = q.enqueue({ reservation_id: 'rB', action: 'CREATE_BOOKING' }).item;

  const first = q.dequeue();                       // FIFO -> a, now PROCESSING
  assert.equal(first.id, a.id);
  assert.equal(first.status, STATUS.PROCESSING);
  assert.equal(q.get(a.id).status, STATUS.PROCESSING);

  assert.equal(q.markCompleted(a.id).status, STATUS.COMPLETED);
  assert.equal(q.list(STATUS.PENDING).map((x) => x.id).join(), b.id);  // only b pending
  assert.equal(q.markFailed(b.id).status, STATUS.FAILED);
  assert.equal(q.dequeue(), null);                 // nothing pending left
});

test('dedupe frees after leaving PENDING: same key can re-enqueue once processing', () => {
  const q = buildChannelSyncQueue();
  const a = q.enqueue({ reservation_id: 'r9', action: 'CHECK_IN' }).item;
  assert.equal(q.enqueue({ reservation_id: 'r9', action: 'CHECK_IN' }).accepted, false); // still pending
  q.markProcessing(a.id);
  assert.equal(q.enqueue({ reservation_id: 'r9', action: 'CHECK_IN' }).accepted, true);  // freed
  q.clear();
  assert.equal(q.size(), 0);
});

test('subscriber flow: reservation.created -> CREATE_BOOKING queued as PENDING', async () => {
  const store = buildChannelMappingStore({ clock: () => 1 });
  const queue = buildChannelSyncQueue({ clock: () => 1, idGen: () => 'job-1' });
  const bus = fakeBus();
  const unsub = buildChannelSubscriber({ eventBus: bus, store, queue, resolveChannels });
  try {
    await bus.emit(ev('reservation.created', 'res-1', { status: 'CONFIRMED' }));
    const items = queue.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].action, 'CREATE_BOOKING');
    assert.equal(items[0].reservation_id, 'res-1');
    // PHASE 65 C1 inversion: the job now carries a canonical OTA code, not the
    // 'channel-manager' literal that no provider could ever resolve.
    assert.equal(items[0].channel, 'BOOKING_COM');
    assert.equal(items[0].tenant_id, 't1');
    assert.equal(items[0].property_id, 'p1');
    assert.equal(items[0].status, 'PENDING');
    assert.equal(store.getSyncState('res-1'), 'CREATED'); // S2 still works alongside S3
  } finally { unsub(); }
});

test('subscriber flow: duplicate created event does not double-enqueue', async () => {
  const store = buildChannelMappingStore();
  const queue = buildChannelSyncQueue();
  const bus = fakeBus();
  const unsub = buildChannelSubscriber({ eventBus: bus, store, queue, resolveChannels });
  try {
    await bus.emit(ev('reservation.created', 'res-2'));
    await bus.emit(ev('reservation.created', 'res-2')); // duplicate -> deduped
    assert.equal(queue.size(), 1);
  } finally { unsub(); }
});
