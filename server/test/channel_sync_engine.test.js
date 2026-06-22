'use strict';

/** Phase 10.0 - sync engine: idempotency, retry, partial-failure isolation,
 *  per-OTA rate limiting, delta sync. Clock + sleep are stubbed so there are
 *  no real waits. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { QueueManager } = require('../src/channel-manager/core/sync/QueueManager');
const { RetryPolicy } = require('../src/channel-manager/core/sync/RetryPolicy');
const { SyncEngine } = require('../src/channel-manager/core/sync/SyncEngine');
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');
const { makeCanonicalRate } = require('../src/channel-manager/core/canonical/CanonicalRate');

const noSleep = () => Promise.resolve();

test('idempotency: duplicate key is dropped; op runs once', async () => {
  const q = new QueueManager({ sleep: noSleep });
  let runs = 0;
  const job = { idempotencyKey: 'K1', channel: CHANNELS.BOOKING_COM, run: async () => { runs += 1; } };
  assert.equal(q.enqueue(job).accepted, true);
  const dup = q.enqueue({ idempotencyKey: 'K1', channel: CHANNELS.BOOKING_COM, run: async () => { runs += 1; } });
  assert.equal(dup.deduped, true);
  await q.process();
  assert.equal(runs, 1);
});

test('retry with backoff: fails twice then succeeds', async () => {
  const q = new QueueManager({ retryPolicy: new RetryPolicy({ maxAttempts: 5, baseMs: 1 }), sleep: noSleep });
  let n = 0;
  q.enqueue({ idempotencyKey: 'R', channel: 'X', run: async () => { n += 1; if (n < 3) throw new Error('boom'); return 'ok'; } });
  const [res] = await q.process();
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
});

test('partial failure isolation: one job fails, others still succeed + dead-letter', async () => {
  const q = new QueueManager({ retryPolicy: new RetryPolicy({ maxAttempts: 1 }), sleep: noSleep });
  q.enqueue({ idempotencyKey: 'a', channel: 'X', run: async () => 'A' });
  q.enqueue({ idempotencyKey: 'b', channel: 'X', run: async () => { throw new Error('fail-b'); } });
  q.enqueue({ idempotencyKey: 'c', channel: 'X', run: async () => 'C' });
  const results = await q.process();
  assert.equal(results.length, 3);
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(q.deadLetter.length, 1);
  assert.equal(q.deadLetter[0].idempotencyKey, 'b');
});

test('per-OTA rate limiting enforces a minimum interval', async () => {
  const waited = [];
  const q = new QueueManager({
    sleep: (ms) => { waited.push(ms); return Promise.resolve(); },
    clock: () => 1_000_000,                          // frozen clock
    rateLimits: { [CHANNELS.BOOKING_COM]: 1000 }
  });
  q.enqueue({ idempotencyKey: 'j1', channel: CHANNELS.BOOKING_COM, run: async () => 1 });
  q.enqueue({ idempotencyKey: 'j2', channel: CHANNELS.BOOKING_COM, run: async () => 2 });
  await q.process();
  assert.ok(waited.includes(1000), 'second same-channel job waited the min interval; waited=' + JSON.stringify(waited));
});

test('delta sync: unchanged rate is skipped, changed rate syncs', async () => {
  const emitted = [];
  const fakeBus = { emit: async (e) => emitted.push(e.type) };
  const q = new QueueManager({ sleep: noSleep });
  const eng = new SyncEngine({ queue: q, eventBus: fakeBus });
  const adapter = { channel: CHANNELS.BOOKING_COM, pushRates: async () => {} };
  const rate = makeCanonicalRate({ propertyId: 'p', roomTypeId: 'rt', date: '2026-07-01', amount: 100 });

  const first = await eng.syncRate(adapter, rate, {});
  assert.equal(first.ok, true);
  const second = await eng.syncRate(adapter, rate, {});      // identical
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'no_delta');
  const changed = await eng.syncRate(adapter, makeCanonicalRate({ propertyId: 'p', roomTypeId: 'rt', date: '2026-07-01', amount: 150 }), {});
  assert.equal(changed.ok, true);
  assert.deepEqual(emitted, ['channel.rate_updated', 'channel.rate_updated']);
});
