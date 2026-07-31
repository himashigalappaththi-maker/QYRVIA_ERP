'use strict';

/**
 * Phase 24 B6 / repaired Phase 66A-B2J / kill switch Phase 66A-B2K / registry
 * gate Phase 66A-B2L / durable retry & dead-letter Phase 66A-B2M — channel
 * queue worker.
 *
 * Tests 1, 2 exercise leaseQueue.js directly — unmodified, standalone, no
 * longer the queue channelQueueWorker.js depends on in production, so they
 * never construct a worker. The retry-policy unit test near the end exercises
 * workerRetryPolicy.js directly — also unmodified; channelQueueWorker.js now
 * uses it as its DEFAULT retryPolicy (still fully overridable via the
 * constructor for deterministic tests below).
 *
 * Every other test exercises buildChannelQueueWorker() itself, against a
 * small fake matching its Phase 66A-B2M FOUR-method queue contract
 * (dequeuePendingAcrossTenants / markCompleted / markRetryScheduled /
 * markDeadLetter) — the same contract server/src/channel-manager/persistence/
 * dbStores.js's dequeuePendingAcrossTenants + markQueueCompletedForTenant +
 * markQueueRetryScheduledForTenant + markQueueDeadLetterForTenant satisfy in
 * db-persistence mode. markFailed is NO LONGER part of this contract — see
 * channelQueueWorker.js's own header for why. No database connection is
 * opened anywhere in this file.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildLeaseQueue, STATUS } = require('../src/channel-manager/worker/leaseQueue');
const { buildMockProcessor } = require('../src/channel-manager/worker/mockProcessor');
const { buildChannelQueueWorker } = require('../src/channel-manager/worker/channelQueueWorker');
const { buildWorkerRetryPolicy, BACKOFF_MS } = require('../src/channel-manager/worker/workerRetryPolicy');

/** The guard nearly every non-kill-switch test uses: dispatch always permitted. */
const alwaysEnabled = () => true;
/** A deterministic clock so next_retry_at math is exactly predictable. */
const FIXED_NOW = 1_700_000_000_000;
const fixedClock = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// A fake matching channelQueueWorker's Phase 66A-B2M four-method queue
// contract. `batches` is an array of arrays; each dequeuePendingAcrossTenants()
// call consumes (shifts) the next one, or returns [] once exhausted —
// modelling "this many rows were due across however many tenants, this poll".
// ---------------------------------------------------------------------------
function fakeQueue(batches, { dequeueDelayMs = 0 } = {}) {
  const remaining = batches.map((b) => b.slice());
  const completedCalls = [];
  const retryScheduledCalls = [];
  const deadLetterCalls = [];
  let dequeueCalls = 0;
  return {
    async dequeuePendingAcrossTenants() {
      dequeueCalls += 1;
      if (dequeueDelayMs) await new Promise((r) => setTimeout(r, dequeueDelayMs));
      return remaining.length ? remaining.shift() : [];
    },
    async markCompleted(tenantId, id) { completedCalls.push({ tenantId, id }); return { id, status: 'COMPLETED' }; },
    async markRetryScheduled(tenantId, id, nextRetryAt) {
      retryScheduledCalls.push({ tenantId, id, nextRetryAt });
      return { id, status: 'PENDING', next_retry_at: nextRetryAt };
    },
    async markDeadLetter(tenantId, id) {
      deadLetterCalls.push({ tenantId, id });
      return { id, status: 'DEAD_LETTER' };
    },
    completedCalls, retryScheduledCalls, deadLetterCalls,
    get dequeueCallCount() { return dequeueCalls; }
  };
}

const row = (id, tenantId = 't1', { action = 'CREATE_BOOKING', retryCount = 0 } = {}) =>
  ({ id, tenant_id: tenantId, reservation_id: 'r-' + id, action, payload_json: {}, retry_count: retryCount, max_retries: 4 });

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
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false });

  const r = await worker.tick();
  assert.equal(r.idle, false);
  assert.deepEqual(r.results, [{ id: 'a', status: 'COMPLETED' }]);
  assert.deepEqual(queue.completedCalls, [{ tenantId: 't1', id: 'a' }]);
  assert.deepEqual(queue.retryScheduledCalls, []);
  assert.deepEqual(queue.deadLetterCalls, []);
});

// ---- 4. a retryable failure with retries remaining schedules a retry ------
test('failed mock processing with retries remaining schedules a retry, and completion/dead-letter are never called', async () => {
  const queue = fakeQueue([[row('b', 't1', { retryCount: 0 })]]);
  const processor = buildMockProcessor({ shouldFail: () => true }); // error: 'mock_failure' — not in the non-retryable whitelist
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'b', status: 'PENDING', retryScheduled: true }]);
  assert.equal(queue.retryScheduledCalls.length, 1);
  assert.equal(queue.retryScheduledCalls[0].tenantId, 't1');
  assert.equal(queue.retryScheduledCalls[0].id, 'b');
  assert.equal(queue.retryScheduledCalls[0].nextRetryAt.getTime(), FIXED_NOW + BACKOFF_MS[0]);
  assert.deepEqual(queue.completedCalls, [], 'completion must never be called after a processor failure');
  assert.deepEqual(queue.deadLetterCalls, [], 'a retryable failure with budget remaining must not dead-letter');
});

test('a retryable failure at the final allowed attempt is dead-lettered, not rescheduled again', async () => {
  // BACKOFF_MS has length 4 (default max_retries): retry_count=4 means the
  // resolver's own retry_count < max_retries filter would already treat this
  // row as exhausted, so the worker must not schedule a 5th attempt.
  const queue = fakeQueue([[row('b2', 't1', { retryCount: 4 })]]);
  const processor = buildMockProcessor({ shouldFail: () => true });
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'b2', status: 'DEAD_LETTER' }]);
  assert.deepEqual(queue.retryScheduledCalls, []);
  assert.equal(queue.deadLetterCalls.length, 1);
  assert.equal(queue.deadLetterCalls[0].id, 'b2');
});

test('a processor that throws is treated as a retryable failure (stable fallback classification), not an unhandled rejection', async () => {
  const queue = fakeQueue([[row('c', 't1', { retryCount: 0 })]]);
  const processor = buildMockProcessor({ shouldFail: () => 'throw' }); // error: 'mock_processor_threw'
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'c', status: 'PENDING', retryScheduled: true }]);
  assert.deepEqual(queue.completedCalls, []);
  assert.deepEqual(queue.deadLetterCalls, []);
});

// ---- unknown_action / no_provider_for_channel are non-retryable ------------
test('a non-retryable failure code (unknown_action) is dead-lettered immediately, even on the very first attempt', async () => {
  const queue = fakeQueue([[row('nr1', 't1', { retryCount: 0 })]]);
  const processor = { async process() { return { ok: false, error: 'unknown_action' }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'nr1', status: 'DEAD_LETTER' }]);
  assert.deepEqual(queue.retryScheduledCalls, [], 'a non-retryable failure must not consume a retry cycle');
});

for (const code of ['unknown_action', 'channel_required', 'tenant_required', 'no_provider_for_channel']) {
  test(`non-retryable code ${code} dead-letters immediately`, async () => {
    const queue = fakeQueue([[row('nr-' + code, 't1', { retryCount: 0 })]]);
    const processor = { async process() { return { ok: false, error: code }; } };
    const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });
    const r = await worker.tick();
    assert.equal(r.results[0].status, 'DEAD_LETTER');
  });
}

for (const code of ['channel_disabled', 'transport_disabled', 'qtcn_dispatch_error', 'transport_error', 'mock_failure', 'some_uncategorized_error']) {
  test(`retryable-by-default code ${code} schedules a retry when budget remains`, async () => {
    const queue = fakeQueue([[row('rt-' + code, 't1', { retryCount: 0 })]]);
    const processor = { async process() { return { ok: false, error: code }; } };
    const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });
    const r = await worker.tick();
    assert.equal(r.results[0].status, 'PENDING');
    assert.equal(r.results[0].retryScheduled, true);
  });
}

// ---- 5. empty dequeue produces no processor call ---------------------------
test('an empty dequeue result produces no processor call and reports idle', async () => {
  let processCalls = 0;
  const queue = fakeQueue([[]]);
  const processor = { async process() { processCalls += 1; return { ok: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false });

  const r = await worker.tick();
  assert.equal(r.idle, true);
  assert.equal(processCalls, 0);
});

// ---- 6. multiple claimed rows are processed deterministically -------------
test('multiple claimed rows (across tenants) are each processed exactly once, in order', async () => {
  const seen = [];
  const queue = fakeQueue([[row('x', 'tenantA'), row('y', 'tenantB'), row('z', 'tenantA')]]);
  const processor = { async process(job) { seen.push(job.id); return { ok: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false });

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
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false });

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
  const w = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), isDispatchEnabled: alwaysEnabled, enabled: false });
  assert.equal(w.start(), false);
  assert.equal(w.isRunning(), false);
});

test('worker enabled mode: start()/stop() manage the loop', () => {
  const queue = fakeQueue([[]]);
  const w = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), isDispatchEnabled: alwaysEnabled, enabled: true, pollMs: 10000 });
  assert.equal(w.start(), true);
  assert.equal(w.isRunning(), true);
  assert.equal(w.start(), true, 'calling start() again while already running is idempotent, not a second timer');
  w.stop();
  assert.equal(w.isRunning(), false);
});

// ---- metrics ----------------------------------------------------------------
test('metrics: processed / completed / retried / deadLettered / disabledTicks session counters', async () => {
  const queue = fakeQueue([[row('ok1'), row('bad', 't1', { retryCount: 4 })]]);
  const processor = { async process(job) { return { ok: job.id !== 'bad' }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  await worker.tick();
  const m = worker.metrics();
  assert.equal(m.processed, 2);
  assert.equal(m.completed, 1);
  assert.equal(m.deadLettered, 1, 'the "bad" job was already at retry_count=4 (exhausted), so it dead-letters');
  assert.equal(m.retried, 0);
  assert.equal(m.disabledTicks, 0);
});

// ---- constructor validation --------------------------------------------------
test('buildChannelQueueWorker requires the four-method queue contract and isDispatchEnabled', () => {
  assert.throws(() => buildChannelQueueWorker({ queue: {}, processor: buildMockProcessor(), isDispatchEnabled: alwaysEnabled }),
    /dequeuePendingAcrossTenants/);
  assert.throws(() => buildChannelQueueWorker({
    queue: { dequeuePendingAcrossTenants: async () => [] }, processor: buildMockProcessor(), isDispatchEnabled: alwaysEnabled
  }), /markCompleted/);
  assert.throws(() => buildChannelQueueWorker({
    queue: { dequeuePendingAcrossTenants: async () => [], markCompleted: async () => {} },
    processor: buildMockProcessor(), isDispatchEnabled: alwaysEnabled
  }), /markRetryScheduled/);
  assert.throws(() => buildChannelQueueWorker({
    queue: {
      dequeuePendingAcrossTenants: async () => [], markCompleted: async () => {},
      markRetryScheduled: async () => {}
    },
    processor: buildMockProcessor(), isDispatchEnabled: alwaysEnabled
  }), /markDeadLetter/);
  assert.throws(() => buildChannelQueueWorker({
    queue: fakeQueue([[]]), processor: buildMockProcessor()
    // isDispatchEnabled omitted entirely
  }), /isDispatchEnabled/);
});

// ---------------------------------------------------------------------------
// Phase 66A-B2K — fail-closed dispatch kill switch
// ---------------------------------------------------------------------------

test('a disabled guard (false) returns the stable disabled result and claims nothing', async () => {
  const queue = fakeQueue([[row('a')]]);
  const worker = buildChannelQueueWorker({
    queue, processor: buildMockProcessor(), isDispatchEnabled: () => false, enabled: false
  });
  const r = await worker.tick();
  assert.deepEqual(r, { disabled: true, reason: 'dispatch_disabled', results: [] });
  assert.equal(queue.dequeueCallCount, 0, 'dequeuePendingAcrossTenants must never be called while disabled');
  assert.deepEqual(queue.completedCalls, []);
  assert.deepEqual(queue.retryScheduledCalls, []);
  assert.deepEqual(queue.deadLetterCalls, []);
});

test('a disabled guard never calls processor.process', async () => {
  let processCalls = 0;
  const queue = fakeQueue([[row('a')]]);
  const processor = { async process() { processCalls += 1; return { ok: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: () => false, enabled: false });
  await worker.tick();
  assert.equal(processCalls, 0);
});

test('missing/undefined guard return value fails closed', async () => {
  const queue = fakeQueue([[row('a')]]);
  const worker = buildChannelQueueWorker({
    queue, processor: buildMockProcessor(), isDispatchEnabled: () => undefined, enabled: false
  });
  const r = await worker.tick();
  assert.equal(r.disabled, true);
  assert.equal(queue.dequeueCallCount, 0);
});

test('a non-boolean truthy guard value (1, "true", an object) does not enable dispatch', async () => {
  for (const truthy of [1, 'true', {}, [], 'yes']) {
    const queue = fakeQueue([[row('a')]]);
    const worker = buildChannelQueueWorker({
      queue, processor: buildMockProcessor(), isDispatchEnabled: () => truthy, enabled: false
    });
    const r = await worker.tick();
    assert.equal(r.disabled, true, 'truthy value ' + JSON.stringify(truthy) + ' must not enable dispatch');
    assert.equal(queue.dequeueCallCount, 0);
  }
});

test('a guard that throws synchronously fails closed and claims nothing', async () => {
  const queue = fakeQueue([[row('a')]]);
  const worker = buildChannelQueueWorker({
    queue, processor: buildMockProcessor(),
    isDispatchEnabled: () => { throw new Error('boom'); },
    enabled: false
  });
  const r = await worker.tick();
  assert.deepEqual(r, { disabled: true, reason: 'dispatch_guard_error', results: [] });
  assert.equal(queue.dequeueCallCount, 0);
});

test('a guard that returns a rejected promise fails closed and claims nothing', async () => {
  const queue = fakeQueue([[row('a')]]);
  const worker = buildChannelQueueWorker({
    queue, processor: buildMockProcessor(),
    isDispatchEnabled: () => Promise.reject(new Error('async boom')),
    enabled: false
  });
  const r = await worker.tick();
  assert.deepEqual(r, { disabled: true, reason: 'dispatch_guard_error', results: [] });
  assert.equal(queue.dequeueCallCount, 0);
});

test('the disabled-tick result never includes tenant, row or environment detail', async () => {
  const queue = fakeQueue([[row('secret-id', 'secret-tenant')]]);
  const worker = buildChannelQueueWorker({
    queue, processor: buildMockProcessor(), isDispatchEnabled: () => false, enabled: false
  });
  const r = await worker.tick();
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes('secret-id'));
  assert.ok(!serialized.includes('secret-tenant'));
});

test('an enabled guard preserves the existing mock-success path', async () => {
  const queue = fakeQueue([[row('ok')]]);
  const processor = buildMockProcessor({ shouldFail: () => false });
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: () => true, enabled: false });
  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'ok', status: 'COMPLETED' }]);
});

test('an enabled guard preserves the retryable-failure path', async () => {
  const queue = fakeQueue([[row('bad')]]);
  const processor = buildMockProcessor({ shouldFail: () => true });
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: () => true, enabled: false, clock: fixedClock });
  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'bad', status: 'PENDING', retryScheduled: true }]);
});

test('the guard is re-evaluated on every tick — changing it between ticks changes behavior without reconstructing the worker', async () => {
  let dispatchState = false;
  const queue = fakeQueue([[row('a')], [row('b')]]);
  const processor = buildMockProcessor({ shouldFail: () => false });
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: () => dispatchState, enabled: false });

  const r1 = await worker.tick();
  assert.equal(r1.disabled, true, 'still disabled on the first tick');
  assert.equal(queue.dequeueCallCount, 0);

  dispatchState = true;
  const r2 = await worker.tick();
  assert.equal(r2.disabled, undefined, 'now enabled, same worker instance, no reconstruction');
  assert.deepEqual(r2.results, [{ id: 'a', status: 'COMPLETED' }]);
  assert.equal(queue.dequeueCallCount, 1);

  dispatchState = false;
  const r3 = await worker.tick();
  assert.equal(r3.disabled, true, 'disabled again on the very next tick, no caching of the earlier enabled state');
  assert.equal(queue.dequeueCallCount, 1, 'no further dequeue attempted while disabled again');
});

test('an overlapping tick remains protected even when the guard is disabled', async () => {
  const queue = fakeQueue([[]]);
  let guardCalls = 0;
  const isDispatchEnabled = async () => { guardCalls += 1; await new Promise((r) => setTimeout(r, 20)); return false; };
  const worker = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), isDispatchEnabled, enabled: false });

  const [r1, r2] = await Promise.all([worker.tick(), worker.tick()]);
  const skippedCount = [r1, r2].filter((r) => r.skipped).length;
  assert.equal(skippedCount, 1, 'exactly one of the two concurrent ticks is skipped by the overlap guard');
  assert.equal(guardCalls, 1, 'the skipped tick never even reached the dispatch guard');
});

test('an empty, enabled tick still reports idle (not disabled)', async () => {
  const queue = fakeQueue([[]]);
  const worker = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), isDispatchEnabled: () => true, enabled: false });
  const r = await worker.tick();
  assert.equal(r.idle, true);
  assert.equal(r.disabled, undefined);
});

test('disabledTicks metric increments only while disabled, and stops incrementing once enabled', async () => {
  let dispatchState = false;
  const queue = fakeQueue([[], []]);
  const worker = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), isDispatchEnabled: () => dispatchState, enabled: false });

  await worker.tick();
  assert.equal(worker.metrics().disabledTicks, 1);
  dispatchState = true;
  await worker.tick();
  assert.equal(worker.metrics().disabledTicks, 1, 'an enabled idle tick does not count as a disabled tick');
});

// ---- 10. retry policy unit (workerRetryPolicy.js directly, unaffected) -----
test('retry policy: backoff schedule then stop', () => {
  const rp = buildWorkerRetryPolicy();
  assert.deepEqual(rp.next(0), { retry: true, delayMs: 60000, attempt: 1 });
  assert.deepEqual(rp.next(3), { retry: true, delayMs: 3600000, attempt: 4 });
  assert.deepEqual(rp.next(4), { retry: false, delayMs: null, attempt: 5 });
});

// -----------------------------------------------------------------------------
// Phase 66A-B2L: registry-denied ({ ok:false, skipped:true }) result routing.
// Phase 66A-B2M changed WHAT queue transition a failure uses (retry-scheduled
// or dead-lettered instead of a one-shot terminal FAILED), but a registry
// denial is still classified retryable-by-default (see channelQueueWorker.js's
// header) and is still separately observable via stats.registryDenied,
// regardless of which of the two new transitions it ends up using.
// -----------------------------------------------------------------------------

test('a registry-denied ({ ok:false, skipped:true }) result with budget remaining schedules a retry, never marks completed', async () => {
  const queue = fakeQueue([[row('d', 't1', { retryCount: 0 })]]);
  const processor = { async process() { return { ok: false, error: 'channel_disabled', skipped: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  const r = await worker.tick();
  assert.deepEqual(r.results, [{ id: 'd', status: 'PENDING', retryScheduled: true, skipped: true }]);
  assert.equal(queue.retryScheduledCalls.length, 1);
  assert.deepEqual(queue.completedCalls, [], 'registry-denied work must never be marked completed');
});

test('a registry-denied result exhausted at max_retries is dead-lettered, still counted as registryDenied', async () => {
  const queue = fakeQueue([[row('d2', 't1', { retryCount: 4 })]]);
  const processor = { async process() { return { ok: false, error: 'channel_disabled', skipped: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  const r = await worker.tick();
  assert.equal(r.results[0].status, 'DEAD_LETTER');
  assert.equal(queue.deadLetterCalls.length, 1);
  assert.equal(worker.metrics().registryDenied, 1);
});

test('a registry-denied result increments stats.registryDenied AND stats.retried when budget remains', async () => {
  const queue = fakeQueue([[row('e', 't1', { retryCount: 0 })]]);
  const processor = { async process() { return { ok: false, error: 'channel_disabled', skipped: true }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  await worker.tick();
  const m = worker.metrics();
  assert.equal(m.registryDenied, 1);
  assert.equal(m.retried, 1);
  assert.equal(m.deadLettered, 0);
});

test('a genuine retryable processor failure (ok:false, no skipped flag) increments stats.retried, not stats.registryDenied', async () => {
  const queue = fakeQueue([[row('f', 't1', { retryCount: 0 })]]);
  const processor = { async process() { return { ok: false, error: 'transport_error' }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  await worker.tick();
  const m = worker.metrics();
  assert.equal(m.retried, 1);
  assert.equal(m.registryDenied, 0);
});

test('a mix of success, genuine retryable failure and registry-denied rows is routed and counted independently', async () => {
  const queue = fakeQueue([[row('ok', 't1', { retryCount: 0 }), row('bad', 't1', { retryCount: 0 }), row('denied', 't1', { retryCount: 0 })]]);
  const processor = {
    async process(job) {
      if (job.id === 'ok') return { ok: true, result: { mocked: true } };
      if (job.id === 'bad') return { ok: false, error: 'transport_error' };
      return { ok: false, error: 'channel_disabled', skipped: true };
    }
  };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  await worker.tick();
  const m = worker.metrics();
  assert.equal(m.completed, 1);
  assert.equal(m.retried, 2, 'both the genuine failure and the registry denial were retryable with budget remaining');
  assert.equal(m.registryDenied, 1);
  assert.deepEqual(queue.completedCalls, [{ tenantId: 't1', id: 'ok' }]);
  assert.equal(queue.retryScheduledCalls.length, 2);
});

test('metrics() exposes registryDenied alongside processed/completed/retried/deadLettered/disabledTicks, starting at zero', () => {
  const queue = fakeQueue([[]]);
  const worker = buildChannelQueueWorker({ queue, processor: buildMockProcessor(), isDispatchEnabled: alwaysEnabled, enabled: false });
  const m = worker.metrics();
  assert.equal(m.registryDenied, 0);
  assert.equal(m.retried, 0);
  assert.equal(m.deadLettered, 0);
});

// -----------------------------------------------------------------------------
// Phase 66A-B2M: backoff computation and injected clock
// -----------------------------------------------------------------------------

test('next_retry_at is computed from the injected clock plus the retry policy\'s delayMs for the pre-increment retry_count', async () => {
  // Only retry_count 0, 1, 2 still have budget remaining under max_retries=4
  // ((retry_count+1) < max_retries) — retry_count=3 would dead-letter (see
  // the dedicated exhaustion test above), not schedule a 4th attempt.
  const queue = fakeQueue([[row('bo0', 't1', { retryCount: 0 }), row('bo1', 't1', { retryCount: 1 }), row('bo2', 't1', { retryCount: 2 })]]);
  const processor = { async process() { return { ok: false, error: 'transport_error' }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  await worker.tick();
  assert.equal(queue.retryScheduledCalls.length, 3);
  assert.equal(queue.retryScheduledCalls[0].nextRetryAt.getTime(), FIXED_NOW + BACKOFF_MS[0]);
  assert.equal(queue.retryScheduledCalls[1].nextRetryAt.getTime(), FIXED_NOW + BACKOFF_MS[1]);
  assert.equal(queue.retryScheduledCalls[2].nextRetryAt.getTime(), FIXED_NOW + BACKOFF_MS[2]);
  assert.equal(queue.deadLetterCalls.length, 0);
});

test('a max_retries larger than the retryPolicy\'s own backoff schedule reuses the longest configured delay instead of a null delayMs', async () => {
  // retryPolicy's default backoff has length 4 (indices 0-3); max_retries=6
  // means budget is still open at retry_count=4, past the policy's own array
  // bounds — the capped-index defense must reuse BACKOFF_MS[3], not crash.
  const jobRow = { id: 'cap', tenant_id: 't1', reservation_id: 'r-cap', action: 'CREATE_BOOKING', payload_json: {}, retry_count: 4, max_retries: 6 };
  const capQueue = fakeQueue([[jobRow]]);
  const processor = { async process() { return { ok: false, error: 'transport_error' }; } };
  const worker = buildChannelQueueWorker({ queue: capQueue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  await worker.tick();
  assert.equal(capQueue.retryScheduledCalls.length, 1);
  assert.equal(capQueue.retryScheduledCalls[0].nextRetryAt.getTime(), FIXED_NOW + BACKOFF_MS[BACKOFF_MS.length - 1]);
});

test('a custom injected retryPolicy is honored instead of the default workerRetryPolicy', async () => {
  const queue = fakeQueue([[row('custom', 't1', { retryCount: 0 })]]);
  const processor = { async process() { return { ok: false, error: 'transport_error' }; } };
  const customPolicy = { next: (n) => (n < 1 ? { retry: true, delayMs: 5000, attempt: n + 1 } : { retry: false, delayMs: null, attempt: n + 1 }) };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock, retryPolicy: customPolicy });

  await worker.tick();
  assert.equal(queue.retryScheduledCalls[0].nextRetryAt.getTime(), FIXED_NOW + 5000);
});

test('no retry ever sleeps — a full backoff cycle across several rows resolves synchronously fast', async () => {
  const queue = fakeQueue([[row('s0', 't1', { retryCount: 0 }), row('s1', 't1', { retryCount: 1 }), row('s2', 't1', { retryCount: 2 })]]);
  const processor = { async process() { return { ok: false, error: 'transport_error' }; } };
  const worker = buildChannelQueueWorker({ queue, processor, isDispatchEnabled: alwaysEnabled, enabled: false, clock: fixedClock });

  const start = Date.now();
  await worker.tick();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, 'a backoff of up to 60 minutes must never be spent actually sleeping (elapsed=' + elapsed + 'ms)');
});
