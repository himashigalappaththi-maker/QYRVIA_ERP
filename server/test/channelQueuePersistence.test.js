'use strict';

/** Phase 24 B5 - Queue persistence activation: factory queue, db wiring, dual mirror, parity. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelPersistence } = require('../src/channel-manager/persistence');
const { buildSyncQueueStoreMemory } = require('../src/channel-manager/persistence/memoryStores');
const { compareQueues } = require('../src/channel-manager/persistence/queueParity');

// Configurable fake pg client: records queries, can simulate ON CONFLICT DO NOTHING.
function fakeDb({ noRowOn } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (noRowOn && noRowOn(text)) return { rows: [] };
      if (/count\(\*\)/i.test(text)) return { rows: [{ n: 1 }] };
      return { rows: [{ id: 'uuid-1', reservation_id: (params && params[2]) || 'r',
        action: (params && params[3]) || 'CREATE_BOOKING', status: 'PENDING' }] };
    }
  };
}
const found = (db, re) => db.calls.some((c) => re.test(c.text));

// ---- memory mode (the live default): full lifecycle preserved -------------
test('memory queue (via factory): FIFO + dedupe + transitions preserved', () => {
  const p = buildChannelPersistence({ mode: 'memory' });
  assert.equal(p.mode, 'memory');
  const q = p.queue;

  const a = q.enqueue({ reservation_id: 'rA', action: 'CREATE_BOOKING' });
  assert.equal(a.accepted, true);
  assert.equal(q.enqueue({ reservation_id: 'rA', action: 'CREATE_BOOKING' }).deduped, true); // PENDING dedupe
  const b = q.enqueue({ reservation_id: 'rB', action: 'CREATE_BOOKING' }).item;

  const first = q.dequeue();                       // FIFO -> rA
  assert.equal(first.reservation_id, 'rA');
  assert.equal(first.status, 'PROCESSING');
  assert.equal(q.markCompleted(first.id).status, 'COMPLETED');
  assert.equal(q.get(b.id).status, 'PENDING');
  assert.equal(q.markFailed(b.id).status, 'FAILED');
  assert.equal(q.list('COMPLETED').length, 1);
  assert.equal(q.list('FAILED').length, 1);
  assert.equal(q.size(), 2);
});

// ---- db mode: repository ops issue the right SQL --------------------------
test('db queue: all 7 ops issue correct SQL (S3 guarantees preserved in SQL)', async () => {
  const db = fakeDb();
  const p = buildChannelPersistence({ mode: 'db', db });
  assert.equal(p.mode, 'db');
  const q = p.queue;

  await q.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING', channel: 'booking.com' });
  await q.dequeue();
  await q.markProcessing('id1');
  await q.markCompleted('id1');
  await q.markFailed('id2');
  await q.get('id1');
  await q.list('PENDING');

  assert.ok(found(db, /INSERT INTO channel_sync_queue_store/), 'enqueue inserts');
  assert.ok(found(db, /ON CONFLICT[\s\S]*WHERE status = 'PENDING'[\s\S]*DO NOTHING/), 'PENDING dedupe in SQL');
  assert.ok(found(db, /SET status = 'PROCESSING'[\s\S]*SKIP LOCKED/), 'FIFO dequeue + lock');
  assert.ok(found(db, /SET status='COMPLETED'/), 'completed tracking');
  assert.ok(found(db, /SET status='FAILED', attempts=attempts\+1/), 'failed tracking + attempts');
  assert.ok(found(db, /SELECT \* FROM channel_sync_queue_store WHERE id = \$1/), 'get');
  assert.ok(found(db, /WHERE status = \$1/), 'list by status');
});

test('db queue enqueue: ON CONFLICT returns deduped when no row', async () => {
  const db = fakeDb({ noRowOn: (t) => /INSERT INTO channel_sync_queue_store/.test(t) });
  const p = buildChannelPersistence({ mode: 'db', db });
  const res = await p.queue.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING' });
  assert.equal(res.accepted, false);
  assert.equal(res.deduped, true);
});

// ---- dual mode: write memory + db, read memory ---------------------------
test('dual queue: enqueue mirrors to db and returns memory result', () => {
  const db = fakeDb();
  const p = buildChannelPersistence({ mode: 'dual', db });
  assert.equal(p.mode, 'dual');
  const res = p.queue.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING' });
  assert.equal(res.accepted, true);                       // memory result (synchronous)
  assert.ok(found(db, /INSERT INTO channel_sync_queue_store/), 'db mirror invoked');
  assert.equal(p.queue.size(), 1);                        // memory authoritative
});

// ---- parity tooling ------------------------------------------------------
test('parity: identical queues report ok with counts + status', async () => {
  const a = buildSyncQueueStoreMemory();
  const b = buildSyncQueueStoreMemory();
  for (const q of [a, b]) {
    q.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING' });
    q.enqueue({ reservation_id: 'r2', action: 'CHECK_IN' });
  }
  const r = await compareQueues(a, b);
  assert.equal(r.ok, true);
  assert.equal(r.memCount, 2);
  assert.equal(r.dbCount, 2);
  assert.deepEqual(r.memByStatus, { PENDING: 2 });
  assert.equal(r.mismatches.length, 0);
});

test('parity: divergence is detected and described', async () => {
  const a = buildSyncQueueStoreMemory();
  const b = buildSyncQueueStoreMemory();
  a.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING' });
  a.enqueue({ reservation_id: 'r2', action: 'CHECK_IN' });
  b.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING' });   // b missing r2
  const r = await compareQueues(a, b);
  assert.equal(r.ok, false);
  assert.equal(r.memCount, 2);
  assert.equal(r.dbCount, 1);
  const countMm = r.mismatches.find((m) => m.type === 'count');
  const stateMm = r.mismatches.find((m) => m.type === 'state');
  assert.ok(countMm && stateMm);
  assert.deepEqual(stateMm.memoryOnly, ['r2::CHECK_IN::PENDING']);
  assert.deepEqual(stateMm.dbOnly, []);
});
