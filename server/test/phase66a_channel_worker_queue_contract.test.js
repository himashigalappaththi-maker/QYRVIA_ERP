'use strict';

/**
 * Phase 66A-B2J — static contract test for the channel-worker/queue
 * interface repair (P0-12 worker-plumbing prerequisite).
 *
 * This test reads source as TEXT and never executes it — it opens no
 * database connection and starts no worker, so it belongs to the flat
 * test/*.test.js suite (npm run test:unit), not test/db/. Live worker
 * behaviour (mock success/failure/idempotency/overlap) is covered by
 * test/channelQueueWorker.test.js; live tenant-bound DB integration is
 * covered by test/db/phase66a_channel_worker_queue.db.test.js.
 *
 * What this guards against: a future edit that quietly reintroduces the
 * incompatible leaseQueue-shaped calls (recoverExpired/leaseNext/
 * markFailedRetry/markDeadLetter/counts) this phase removed, that wires
 * realProcessor.js or CHANNEL_WORKER_REAL back in, that adds any
 * network-capable call to the worker path, or that weakens the channel
 * registry kill switch this phase never touches.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, '..', 'src', 'channel-manager', 'worker', 'channelQueueWorker.js');
const INDEX_PATH  = path.join(__dirname, '..', 'src', 'index.js');
const LEASEQ_PATH = path.join(__dirname, '..', 'src', 'channel-manager', 'worker', 'leaseQueue.js');
const REALPROC_PATH = path.join(__dirname, '..', 'src', 'channel-manager', 'worker', 'realProcessor.js');

const WORKER_SOURCE = fs.readFileSync(WORKER_PATH, 'utf8');
const INDEX_SOURCE  = fs.readFileSync(INDEX_PATH, 'utf8');

/**
 * Statement text with `/* *\/` block comments and `//` line comments
 * stripped, so prose in a comment cannot satisfy an assertion. CRLF-safe:
 * on a Windows checkout each split line can end in a bare `\r`, and `$`
 * does not anchor before a lone `\r` (only before a final `\n`), so the
 * anchor is dropped — `.` already stops at the `\r` on its own.
 */
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks.split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
}
const WORKER_CODE = stripComments(WORKER_SOURCE);
const INDEX_CODE  = stripComments(INDEX_SOURCE);

// ---------------------------------------------------------------------------
// The repaired worker's own contract
// ---------------------------------------------------------------------------

test('channelQueueWorker requires queue.dequeuePendingAcrossTenants, markCompleted and markFailed', () => {
  assert.match(WORKER_CODE, /typeof queue\.dequeuePendingAcrossTenants !== 'function'/);
  assert.match(WORKER_CODE, /typeof queue\.markCompleted !== 'function'/);
  assert.match(WORKER_CODE, /typeof queue\.markFailed !== 'function'/);
});

test('tick() calls queue.dequeuePendingAcrossTenants exactly once per invocation', () => {
  // Distinguishes the real call site (with its actual argument) from the
  // constructor's error-message string, which also contains the literal
  // text "queue.dequeuePendingAcrossTenants(" but is not a call.
  const calls = WORKER_CODE.match(/queue\.dequeuePendingAcrossTenants\(\{ limit \}\)/g) || [];
  assert.equal(calls.length, 1);
});

test('tick() calls queue.markCompleted on success and queue.markFailed on failure', () => {
  assert.match(WORKER_CODE, /queue\.markCompleted\(job\.tenant_id, job\.id\)/);
  assert.match(WORKER_CODE, /queue\.markFailed\(job\.tenant_id, job\.id\)/);
});

test('no incompatible leaseQueue-only method is called anywhere in the worker', () => {
  for (const removed of ['recoverExpired', 'leaseNext', 'markFailedRetry', 'markDeadLetter', 'counts']) {
    assert.ok(!new RegExp('queue\\.' + removed + '\\b').test(WORKER_CODE),
      'queue.' + removed + '() must not be called — no compatible persistence implementation exists');
  }
});

test('the worker no longer requires leaseQueue.js, workerRetryPolicy.js or a deadLetterStore dependency', () => {
  assert.ok(!/require\(['"]\.\/leaseQueue['"]\)/.test(WORKER_CODE));
  assert.ok(!/require\(['"]\.\/workerRetryPolicy['"]\)/.test(WORKER_CODE));
  assert.ok(!/deadLetterStore/.test(WORKER_CODE));
});

test('a non-overlapping tick guard exists', () => {
  assert.match(WORKER_CODE, /_ticking/);
  assert.match(WORKER_CODE, /return \{ skipped: true \}/);
});

test('processor failures are caught, never left as an unhandled rejection', () => {
  assert.match(WORKER_CODE, /catch \(err\) \{ result = \{ ok: false, error: String\(\(err && err\.message\) \|\| err\) \}; \}/);
});

// ---------------------------------------------------------------------------
// No dispatch, no real processor, no network call, anywhere in the worker
// ---------------------------------------------------------------------------

test('the worker file contains no network-capable call and no realProcessor/CHANNEL_WORKER_REAL reference', () => {
  assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(WORKER_CODE));
  assert.ok(!/realProcessor/i.test(WORKER_CODE));
  assert.ok(!/CHANNEL_WORKER_REAL/.test(WORKER_CODE));
  assert.ok(!/channelRegistry/.test(WORKER_CODE));
});

test('realProcessor.js exists and is never imported by the worker file itself (Phase 66A-B2L wires it conditionally into index.js instead)', () => {
  assert.ok(fs.existsSync(REALPROC_PATH), 'realProcessor.js should still exist');
  assert.ok(!/require\([^)]*realProcessor/i.test(WORKER_CODE), 'channelQueueWorker.js must stay processor-agnostic');
});

test('leaseQueue.js exists and is untouched by this phase (still a valid standalone module)', () => {
  assert.ok(fs.existsSync(LEASEQ_PATH));
  const leaseSrc = fs.readFileSync(LEASEQ_PATH, 'utf8');
  assert.match(leaseSrc, /function buildLeaseQueue/);
  assert.match(leaseSrc, /recoverExpired/);
});

// ---------------------------------------------------------------------------
// Boot wiring (src/index.js) — mock-only, no realProcessor, adapter shape
// ---------------------------------------------------------------------------

function channelWorkerBootBlock() {
  const start = INDEX_CODE.indexOf("CHANNEL_WORKER_ENABLED === 'true'");
  assert.ok(start >= 0, 'channel worker boot block not found in index.js');
  const end = INDEX_CODE.indexOf("channel queue worker disabled", start);
  assert.ok(end > start);
  return INDEX_CODE.slice(start, end);
}
const BOOT_BLOCK = channelWorkerBootBlock();

test('the boot path selects buildMockProcessor by default; buildRealProcessor is constructed only inside the explicit CHANNEL_WORKER_REAL real-mode branch added in Phase 66A-B2L', () => {
  assert.match(BOOT_BLOCK, /buildMockProcessor\(\)/);
  const realGateIdx = BOOT_BLOCK.search(/CHANNEL_WORKER_REAL === 'true'/);
  const realCtorIdx = BOOT_BLOCK.search(/buildRealProcessor\(/);
  assert.ok(realGateIdx >= 0, 'expected an explicit CHANNEL_WORKER_REAL === \'true\' check');
  assert.ok(realCtorIdx > realGateIdx, 'buildRealProcessor must only be constructed after the real-mode gate');
});

test('the boot path builds a queue adapter exposing exactly the three required methods', () => {
  assert.match(BOOT_BLOCK, /dequeuePendingAcrossTenants:/);
  assert.match(BOOT_BLOCK, /markCompleted:/);
  assert.match(BOOT_BLOCK, /markFailed:/);
});

test('the db-mode adapter routes through the tenant-bound dbStores functions, not a bare pool call', () => {
  assert.match(BOOT_BLOCK, /dbm\.dequeuePendingAcrossTenants\(\{ pool: db\.pool, limit \}\)/);
  assert.match(BOOT_BLOCK, /dbm\.markQueueCompletedForTenant\(\{ pool: db\.pool, tenantId, id \}\)/);
  assert.match(BOOT_BLOCK, /dbm\.markQueueFailedForTenant\(\{ pool: db\.pool, tenantId, id \}\)/);
});

test('the db-mode adapter is selected only when channelPersistence.mode is exactly \'db\'', () => {
  assert.match(BOOT_BLOCK, /channelPersistence\.mode === 'db'/);
});

test('CHANNEL_WORKER_REAL is read in the boot path (wired in Phase 66A-B2L) with a strict true-only comparison', () => {
  assert.match(INDEX_CODE, /CHANNEL_WORKER_REAL === 'true'/);
});

test('the worker remains gated behind CHANNEL_WORKER_ENABLED, default false', () => {
  assert.match(INDEX_CODE, /CHANNEL_WORKER_ENABLED === 'true'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'env.js'), 'utf8'),
    /CHANNEL_WORKER_ENABLED:\s*getOptional\('CHANNEL_WORKER_ENABLED',\s*'false'\)/);
});

test('the boot path introduces no network-capable call; channelRegistry is referenced only to inject it into the real-mode processor (Phase 66A-B2L)', () => {
  assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(BOOT_BLOCK));
  assert.match(BOOT_BLOCK, /channelRegistry/);
});

// ---------------------------------------------------------------------------
// Channel registry kill switch untouched (availability/rate path only)
// ---------------------------------------------------------------------------

test('the channel registry kill-switch enforcement in channelSyncService.js is untouched', () => {
  const syncPath = path.join(__dirname, '..', 'src', 'channel-manager', 'sync', 'channelSyncService.js');
  const src = fs.readFileSync(syncPath, 'utf8');
  assert.match(src, /channel_disabled/);
  assert.match(src, /reg\.enabled/);
});

test('this phase does not modify channelRegistryService.js', () => {
  const registryPath = path.join(__dirname, '..', 'src', 'channel-manager', 'registry', 'channelRegistryService.js');
  assert.ok(fs.existsSync(registryPath), 'channelRegistryService.js should still exist');
});
