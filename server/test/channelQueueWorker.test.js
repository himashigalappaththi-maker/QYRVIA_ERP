'use strict';

/**
 * Phase 24 B6 / repaired Phase 66A-B2J - channel queue worker.
 *
 * Tests 1, 2 and 10 exercise leaseQueue.js and workerRetryPolicy.js directly
 * — both modules are unmodified by the Phase 66A-B2J repair and remain
 * correct, standalone in-memory utilities; they are just no longer the
 * queue channelQueueWorker.js depends on in production, so these tests
 * never construct a worker.
 *
 * Every other test exercises buildChannelQueueWorker() itself, against a
 * small fake matching its NEW three-method contract
 * (dequeuePendingAcrossTenants / markCompleted / markFailed) — the same
 * contract server/src/channel-manager/persistence/dbStores.js's
 * dequeuePendingAcrossTenants + markQueueCompletedForTenant +
 * markQueueFailedForTenant satisfy in db-persistence mode, and the memory
 * queue adapter built in src/index.js satisfies in memory mode. No database
 * connection is opened anywhere in this file.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildLeaseQueue, STATUS } = require('../src/channel-manager/worker/leaseQueue');
const { buildMockProcessor } = require('../src/channel-manager/worker/mockProcessor');
const { buildChannelQueueWorker } = require('../src/channel-manager/worker/channelQueueWorker');
const { buildWorkerRetryPolicy, BACKOFF_MS } = require('../src/channel-manager/worker/workerRetryPolicy');

// ---------------------------------------------------------------------------
// A fake matching channelQueueWorker's new three-method queue contract.
// `batches` is an array of arrays; each dequeuePendingAcrossTenants() call
// consumes (shifts) the next one, or returns [] once exhausted — modelling
// "this many rows were due across however many tenants, this poll".
// ---------------------------------------------------------------------------
function fakeQueue(batches, { dequeueDelayMs = 0 } = {}) {
  const remaining = batches.map((b) => b.slice());
  const completedCalls = [];
  const failedCalls = [];
  let dequeueCalls = 0;
  return {
    async dequeuePendingAcrossTenants() {
      dequeueCalls += 1;
      if (dequeueDelayMs) await new Promise((r) => setTimeout(r, dequeueDelayMs));
      return remaining.length ? remaining.shift() : [];
    },
    async markCompleted(tenantId, id) { completedCalls.push({ tenantId, id }); return { id, status: 'COMPLETED' }; },
    async markFailed(tenantId, id)    { failedCalls.push({ tenantId, id }); return { id, status: 'FAILED' }; },
    completedCalls, failedCalls,
    get dequeueCallCount() { return dequeueCalls; }
  };
}

const row = (id, tenantId = 't1', action = 'CREATE_BOOKING') =>
  ({ id, tenant_id: tenantId, reservation_id: 'r-' + id, action, payload_json: {} });

// ---- 1. lease acquisition (leaseQueue.js directly, unaffected) -------------
test('lease acquisition: leaseNext claims one PENDING job; no double lease', () => {
  const queue = buildLeaseQueue({ clock: () => 1000 });
  queue.enqueue({ tenant_id: 't', reservation_id: 'r1', action: 'CREATE_BOOKING' });
  const a = queue.leaseNext('w1', 1000, 1000);
  assert.equal(a.status, STATUS.PROCESSING);
  assert.equal(a.lease_owner, 'w1');
  assert.equal(a.lease_expires_at, 2000);
  assert.equal(queue.leaseNext('w2', 1000, 1000), null); // already leased -> not re-acquired
});

// ---- 2. lease expiry recovery (leaseQueue.js directly, unaffected) ---------
test('lease expiry recovery: expired PROCESSING returns to PENDING and is re-leasable', () => {
  const queue = buildLeaseQueue({ clock: () => 1000 });
  queue.enqueue({ tenant_id: 't', reservation_id: 'r1', action: 'CREATE_BOOKING' });
  queue.leaseNext('w1', 1000, 1000);                   // lease_expires_at = 2000
  assert.equal(queue.recoverExpired(1500).length, 0);  // not yet expired
  const recovered = queue.recoverExpired(2000);         // expired
  assert.deepEqual(recovered.length, 1);
  const again = queue.leaseNext('w2', 1000, 2000);
  assert.equal(again.lease_owner, 'w2');
});

// ---- 3. successful mock processing marks the row completed ----------------
test('successful mock processing marks the claimed row completed', async () => {
  const queue = fakeQueue([[row('a')]]);
  const processor = buildMockProcessor({ shouldFail: () => false });
  const worker = buildChannelQueueWorker({ queue, processor, enabled: false });

  const r = await worker.tick();
  assert.equal(r.idle, false);
  assert.deepEqual(r.results, [{ id: 'a', status: 'COMPLETED' }]);
  assert.deepEqual(queue.completedCalls, [{ tenantId: 't1', id: 'a' }]);
  assert.deepEqual(queue.failedCalls, []);
});

// ---- 4. failed mock processing uses the persistent failure path -----------
test('failed mock processing uses markFailed, and completion is never called', async () => {
  const queue = fakeQueue([[row('b')]]);
  const processor = buildMockProcessor({ shouldFail: () => true });
  const worker = buildChannelQueueWorker({ queue, processor, enabled: false });

  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'b', status: 'FAILED' }]);
  assert.deepEqual(queue.failedCalls, [{ tenantId: 't1', id: 'b' }]);
  assert.deepEqual(queue.completedCalls, [], 'completion must never be called after a processor failure');
});

test('a processor that throws is treated as a failure, not an unhandled rejection', async () => {
  const queue = fakeQueue([[row('c')]]);
  const processor = buildMockProcessor({ shouldFail: () => 'throw' });
  const worker = buildChannelQueueWorker({ queue, processor, enabled: false });

  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'c', status: 'FAILED' }]);
  assert.deepEqual(queue.completedCalls, []);
});

// ---- 5. empty dequeue produces no processor call ---------------------------
test('an empty dequeue result produces no processor call and reports idle', async () => {
  let processCalls = 0;
  const queue = fakeQueue([[]]);
  const processor = { async process() { processCalls += 1; return { ok: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, enabled: false });

  const r = await worker.tick();
  assert.equal(r.idle, true);
  assert.equal(processCalls, 0);
});

// ---- 6. multiple claimed rows are processed deterministically -------------
test('multiple claimed rows (across tenants) are each processed exactly once, in order', async () => {
  const seen = [];
  const queue = fakeQueue([[row('x', 'tenantA'), row('y', 'tenantB'), row('z', 'tenantA')]]);
  const processor = { async process(job) { seen.push(job.id); return { ok: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, enabled: false });

  const r = await worker.tick();
  assert.deepEqual(seen, ['x', 'y', 'z']);
  assert.equal(r.results.length, 3);
  assert.deepEqual(queue.completedCalls, [
    { tenantId: 'tenantA', id: 'x' },
    { tenantId: 'tenantB', id: 'y' },
    { tenantId: 'tenantA', id: 'z' }
  ]);
});

// ---- 7. duplicate/overlapping ticks cannot double-process the same batch --
test('an overlapping tick is skipped, not double-processed', async () => {
  let processCalls = 0;
  const queue = fakeQueue([[row('a')], [row('b')]], { dequeueDelayMs: 20 });
  const processor = { async process(job) { processCalls += 1; return { ok: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, enabled: false });

  const [r1, r2] = await Promise.all([worker.tick(), worker.tick()]);
  const outcomes = [r1, r2].sort((a, b) => (a.skipped ? 1 : 0) - (b.skipped ? 1 : 0));
  assert.equal(outcomes[1].skipped, true, 'the overlapping call must be skipped, not run concurrently');
  assert.equal(outcomes[0].skipped, undefined);
  assert.equal(processCalls, 1, 'only the first batch was ever processed by the overlapping pair');
  assert.equal(queue.dequeueCallCount, 1, 'the skipped tick never even attempted to dequeue');

  // A later, non-overlapping tick still works normally.
  const r3 = await worker.tick();
  assert.equal(r3.idle, false);
  assert.equal(processCalls, 2);
});

// ---- 8 & 9. worker disabled / enabled modes --------------------------------
test('worker disabled mode: start() is a no-op', () => {
  const queue = fakeQueue([[]]);
  const w = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), enabled: false });
  assert.equal(w.start(), false);
  assert.equal(w.isRunning(), false);
});

test('worker enabled mode: start()/stop() manage the loop', () => {
  const queue = fakeQueue([[]]);
  const w = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), enabled: true, pollMs: 10000 });
  assert.equal(w.start(), true);
  assert.equal(w.isRunning(), true);
  assert.equal(w.start(), true, 'calling start() again while already running is idempotent, not a second timer');
  w.stop();
  assert.equal(w.isRunning(), false);
});

// ---- metrics ----------------------------------------------------------------
test('metrics: processed / completed / failed session counters', async () => {
  const queue = fakeQueue([[row('ok1'), row('bad')]]);
  const processor = { async process(job) { return { ok: job.id !== 'bad' }; } };
  const worker = buildChannelQueueWorker({ queue, processor, enabled: false });

  await worker.tick();
  const m = worker.metrics();
  assert.equal(m.processed, 2);
  assert.equal(m.completed, 1);
  assert.equal(m.failed, 1);
});

// ---- constructor validation --------------------------------------------------
test('buildChannelQueueWorker requires the new three-method queue contract', () => {
  assert.throws(() => buildChannelQueueWorker({ queue: {}, processor: buildMockProcessor() }),
    /dequeuePendingAcrossTenants/);
  assert.throws(() => buildChannelQueueWorker({ queue: { dequeuePendingAcrossTenants: async () => [] }, processor: buildMockProcessor() }),
    /markCompleted/);
  assert.throws(() => buildChannelQueueWorker({
    queue: { dequeuePendingAcrossTenants: async () => [], markCompleted: async () => {} },
    processor: buildMockProcessor()
  }), /markFailed/);
});

// ---- 10. retry policy unit (workerRetryPolicy.js directly, unaffected) -----
test('retry policy: backoff schedule then stop', () => {
  const rp = buildWorkerRetryPolicy();
  assert.deepEqual(rp.next(0), { retry: true, delayMs: 60000, attempt: 1 });
  assert.deepEqual(rp.next(3), { retry: true, delayMs: 3600000, attempt: 4 });
  assert.deepEqual(rp.next(4), { retry: false, delayMs: null, attempt: 5 });
});
