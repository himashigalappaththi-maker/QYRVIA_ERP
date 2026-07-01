'use strict';

/** Phase 24 B6 - durable queue worker: lease, retry, dead-letter, crash recovery (mock; no OTA). */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildLeaseQueue, STATUS } = require('../src/channel-manager/worker/leaseQueue');
const { buildMockProcessor } = require('../src/channel-manager/worker/mockProcessor');
const { buildChannelQueueWorker } = require('../src/channel-manager/worker/channelQueueWorker');
const { buildWorkerRetryPolicy, BACKOFF_MS } = require('../src/channel-manager/worker/workerRetryPolicy');
const { buildDeadLetterStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

function harness({ shouldFail, now0 = 1000 } = {}) {
  let now = now0;
  const clock = () => now;
  const queue = buildLeaseQueue({ clock });
  const dlq = buildDeadLetterStoreMemory({ clock });
  const processor = buildMockProcessor({ shouldFail });
  const worker = buildChannelQueueWorker({ queue, processor, deadLetterStore: dlq, clock, owner: 'w1', leaseMs: 1000 });
  return { queue, dlq, worker, advance: (ms) => { now += ms; }, nowRef: () => now };
}
const job = (rid, action = 'CREATE_BOOKING') => ({ tenant_id: 't', reservation_id: rid, action });

// ---- 1. lease acquisition --------------------------------------------------
test('lease acquisition: leaseNext claims one PENDING job; no double lease', () => {
  const { queue } = harness();
  queue.enqueue(job('r1'));
  const a = queue.leaseNext('w1', 1000, 1000);
  assert.equal(a.status, STATUS.PROCESSING);
  assert.equal(a.lease_owner, 'w1');
  assert.equal(a.lease_expires_at, 2000);
  assert.equal(queue.leaseNext('w2', 1000, 1000), null); // already leased -> not re-acquired
});

// ---- 2. lease expiry recovery ---------------------------------------------
test('lease expiry recovery: expired PROCESSING returns to PENDING and is re-leasable', () => {
  const { queue } = harness();
  queue.enqueue(job('r1'));
  queue.leaseNext('w1', 1000, 1000);          // lease_expires_at = 2000
  assert.equal(queue.recoverExpired(1500).length, 0); // not yet expired
  const recovered = queue.recoverExpired(2000);        // expired
  assert.deepEqual(recovered.length, 1);
  const again = queue.leaseNext('w2', 1000, 2000);
  assert.equal(again.lease_owner, 'w2');
});

// ---- 3. retry progression --------------------------------------------------
test('retry progression: 1m -> 5m -> 15m -> 60m then dead-letter', async () => {
  const { queue, worker, advance } = harness({ shouldFail: () => true });
  queue.enqueue(job('r1'));

  let r = await worker.tick();                 // fail #1 -> RETRY count 1, +1m
  assert.equal(r.status, 'RETRY'); assert.equal(r.retry_count, 1);
  assert.equal(r.next_retry_at, 1000 + BACKOFF_MS[0]);

  assert.equal((await worker.tick()).idle, true); // still backing off -> idle

  advance(BACKOFF_MS[0]);
  r = await worker.tick(); assert.equal(r.retry_count, 2);  // +5m
  advance(BACKOFF_MS[1]);
  r = await worker.tick(); assert.equal(r.retry_count, 3);  // +15m
  advance(BACKOFF_MS[2]);
  r = await worker.tick(); assert.equal(r.retry_count, 4);  // +60m
  advance(BACKOFF_MS[3]);
  r = await worker.tick(); assert.equal(r.status, 'DEAD_LETTER'); // retries exhausted
});

// ---- 4. dead-letter routing -----------------------------------------------
test('dead-letter routing: exhausted job recorded in dead_letter_store', async () => {
  const { queue, dlq, worker, advance } = harness({ shouldFail: () => true });
  queue.enqueue(job('r1'));
  // exhaust all retries
  for (let i = 0; i < BACKOFF_MS.length; i++) { await worker.tick(); advance(BACKOFF_MS[i]); }
  const r = await worker.tick();
  assert.equal(r.status, 'DEAD_LETTER');
  const dl = dlq.list();
  assert.equal(dl.length, 1);
  assert.equal(dl[0].reservation_id, 'r1');
  assert.equal(dl[0].action, 'CREATE_BOOKING');
  assert.equal(dl[0].last_error, 'mock_failure');
  assert.equal(queue.get(r.id).status, STATUS.DEAD_LETTER);
});

// ---- 5. idempotent processing ---------------------------------------------
test('idempotent processing: completed jobs are not re-processed; stale owner ignored', async () => {
  const { queue, worker } = harness({ shouldFail: () => false });
  queue.enqueue(job('r1'));
  const r = await worker.tick();
  assert.equal(r.status, 'COMPLETED');
  assert.equal((await worker.tick()).idle, true);  // not re-leased
  // stale-owner completion is a no-op
  queue.enqueue(job('r2'));
  const leased = queue.leaseNext('w1', 1000, 1000);
  assert.equal(queue.markCompleted(leased.id, 'someone-else'), null);
  assert.equal(queue.get(leased.id).status, STATUS.PROCESSING);
});

// ---- 6 & 7. worker disabled / enabled modes -------------------------------
test('worker disabled mode: start() is a no-op', () => {
  const queue = buildLeaseQueue();
  const w = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), enabled: false });
  assert.equal(w.start(), false);
  assert.equal(w.isRunning(), false);
});

test('worker enabled mode: start()/stop() manage the loop', () => {
  const queue = buildLeaseQueue();
  const w = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), enabled: true, pollMs: 10000 });
  assert.equal(w.start(), true);
  assert.equal(w.isRunning(), true);
  w.stop();
  assert.equal(w.isRunning(), false);
});

// ---- 8. crash recovery simulation -----------------------------------------
test('crash recovery simulation: leased-but-not-finished job is recovered + completed', async () => {
  const { queue, worker, advance, nowRef } = harness({ shouldFail: () => false });
  queue.enqueue(job('r1'));
  // simulate a worker that leased then "crashed" (never completed)
  queue.leaseNext('dead-worker', 1000, nowRef());
  assert.equal(queue.get(queue.list(STATUS.PROCESSING)[0].id).status, STATUS.PROCESSING);
  advance(2000); // lease expires
  const r = await worker.tick(); // tick recovers expired lease, then leases + completes
  assert.equal(r.status, 'COMPLETED');
});

// ---- metrics ---------------------------------------------------------------
test('metrics: depth / processing / completed / failed / dead-letter', async () => {
  const { queue, worker } = harness({ shouldFail: (j) => j.reservation_id === 'bad' });
  queue.enqueue(job('ok1'));
  queue.enqueue(job('bad'));
  await worker.tick(); // ok1 -> COMPLETED
  await worker.tick(); // bad -> RETRY (failure counted)
  const m = worker.metrics();
  assert.equal(m.completed, 1);
  assert.equal(m.failed, 1);
  assert.equal(typeof m.queueDepth, 'number');
  assert.equal(typeof m.deadLetter, 'number');
});

// ---- retry policy unit -----------------------------------------------------
test('retry policy: backoff schedule then stop', () => {
  const rp = buildWorkerRetryPolicy();
  assert.deepEqual(rp.next(0), { retry: true, delayMs: 60000, attempt: 1 });
  assert.deepEqual(rp.next(3), { retry: true, delayMs: 3600000, attempt: 4 });
  assert.deepEqual(rp.next(4), { retry: false, delayMs: null, attempt: 5 });
});
