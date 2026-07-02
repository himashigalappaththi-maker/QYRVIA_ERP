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
const ev = (type, rid, extra = {}) => ({
  event_type: type, aggregate_id: rid, property_id: 'p1',
  occurred_at: '2026-06-24T10:00:00.000Z',
  payload: Object.assign({ reservation_id: rid }, extra)
});

test('queue enqueue produces the documented item shape', () => {
  const q = buildChannelSyncQueue({ clock: () => 123, idGen: () => 'fixed-1' });
  const res = q.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING', channel: 'channel-manager', payload: { a: 1 } });
  assert.equal(res.accepted, true);
  assert.deepEqual(res.item, {
    id: 'fixed-1', reservation_id: 'r1', action: 'CREATE_BOOKING',
    channel: 'channel-manager', payload: { a: 1 }, status: 'PENDING', created_at: 123
  });
  assert.equal(q.size(), 1);
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
  const unsub = buildChannelSubscriber({ eventBus: bus, store, queue });
  try {
    await bus.emit(ev('reservation.created', 'res-1', { status: 'CONFIRMED' }));
    const items = queue.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].action, 'CREATE_BOOKING');
    assert.equal(items[0].reservation_id, 'res-1');
    assert.equal(items[0].channel, 'channel-manager');
    assert.equal(items[0].status, 'PENDING');
    assert.equal(store.getSyncState('res-1'), 'CREATED'); // S2 still works alongside S3
  } finally { unsub(); }
});

test('subscriber flow: duplicate created event does not double-enqueue', async () => {
  const store = buildChannelMappingStore();
  const queue = buildChannelSyncQueue();
  const bus = fakeBus();
  const unsub = buildChannelSubscriber({ eventBus: bus, store, queue });
  try {
    await bus.emit(ev('reservation.created', 'res-2'));
    await bus.emit(ev('reservation.created', 'res-2')); // duplicate -> deduped
    assert.equal(queue.size(), 1);
  } finally { unsub(); }
});
