'use strict';

/**
 * Phase 66A-B2K — static contract test for the fail-closed reservation-action
 * queue dispatch kill switch (P0-12 kill-switch prerequisite).
 *
 * This test reads source as TEXT and never executes it — it opens no
 * database connection and starts no worker, so it belongs to the flat
 * test/*.test.js suite (npm run test:unit), not test/db/. Live guard
 * behaviour (disabled/enabled/guard-failure/re-evaluation) is covered by
 * test/channelQueueWorker.test.js; live tenant-bound DB integration with the
 * real adapter is covered by test/db/phase66a_dispatch_kill_switch.db.test.js.
 *
 * What this guards against: a future edit that removes the
 * CHANNEL_QUEUE_DISPATCH_ENABLED default-false posture, moves the guard
 * check to after dequeue, reuses CHANNEL_WORKER_ENABLED or
 * CHANNEL_WORKER_REAL instead of the dedicated setting, or reintroduces
 * realProcessor/network capability while doing so.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENV_PATH    = path.join(__dirname, '..', 'src', 'config', 'env.js');
const WORKER_PATH = path.join(__dirname, '..', 'src', 'channel-manager', 'worker', 'channelQueueWorker.js');
const INDEX_PATH  = path.join(__dirname, '..', 'src', 'index.js');
const REALPROC_PATH = path.join(__dirname, '..', 'src', 'channel-manager', 'worker', 'realProcessor.js');

const ENV_SOURCE    = fs.readFileSync(ENV_PATH, 'utf8');
const WORKER_SOURCE = fs.readFileSync(WORKER_PATH, 'utf8');
const INDEX_SOURCE  = fs.readFileSync(INDEX_PATH, 'utf8');

/**
 * Statement text with block comments and `//` line comments stripped.
 * CRLF-safe: on Windows checkouts a line ends in a bare `\r` after the
 * split('\n'), and `$` does not anchor before a lone `\r` (only before a
 * final `\n`), so the anchor is dropped in favour of a plain `//.*` match —
 * `.` already stops at the `\r` on its own.
 */
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks.split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
}
const ENV_CODE    = stripComments(ENV_SOURCE);
const WORKER_CODE = stripComments(WORKER_SOURCE);
const INDEX_CODE  = stripComments(INDEX_SOURCE);

// ---------------------------------------------------------------------------
// Environment setting
// ---------------------------------------------------------------------------

test('CHANNEL_QUEUE_DISPATCH_ENABLED exists, defaults to \'false\', via the existing getOptional convention', () => {
  assert.match(ENV_CODE, /CHANNEL_QUEUE_DISPATCH_ENABLED:\s*getOptional\('CHANNEL_QUEUE_DISPATCH_ENABLED',\s*'false'\)/);
});

test('the new setting is distinct from CHANNEL_WORKER_ENABLED and CHANNEL_WORKER_REAL', () => {
  assert.match(ENV_CODE, /CHANNEL_WORKER_ENABLED:\s*getOptional\('CHANNEL_WORKER_ENABLED',\s*'false'\)/);
  assert.ok(!/CHANNEL_WORKER_REAL/.test(ENV_CODE), 'CHANNEL_WORKER_REAL must remain unread in env.js');
  // Two distinct getOptional('CHANNEL_..._ENABLED', 'false') call sites for
  // the two independent worker/dispatch gates — not a shared/reused one.
  const gateDeclarations = ENV_CODE.match(/getOptional\('CHANNEL_(WORKER|QUEUE_DISPATCH)_ENABLED',\s*'false'\)/g) || [];
  assert.equal(gateDeclarations.length, 2);
});

// ---------------------------------------------------------------------------
// Worker guard contract and evaluation location
// ---------------------------------------------------------------------------

test('buildChannelQueueWorker requires isDispatchEnabled as a function', () => {
  assert.match(WORKER_CODE, /typeof isDispatchEnabled !== 'function'/);
});

test('the guard is evaluated after the overlap guard but before dequeuePendingAcrossTenants', () => {
  const ticking = WORKER_CODE.search(/if \(_ticking\) return \{ skipped: true \};/);
  const guardEval = WORKER_CODE.search(/dispatchOk = await isDispatchEnabled\(\);/);
  const dequeueCall = WORKER_CODE.search(/queue\.dequeuePendingAcrossTenants\(\{ limit \}\)/);
  assert.ok(ticking >= 0 && guardEval > ticking && dequeueCall > guardEval,
    'expected order: overlap guard, then dispatch guard, then dequeue');
});

test('only an exact boolean true return value permits a claim', () => {
  assert.match(WORKER_CODE, /dispatchOk !== true/);
});

test('a guard throw or rejection is caught and forced to the disabled path, with a distinct reason', () => {
  assert.match(WORKER_CODE, /guardFailed = true;/);
  assert.match(WORKER_CODE, /reason: guardFailed \? 'dispatch_guard_error' : 'dispatch_disabled'/);
});

test('the disabled result shape carries no tenant/row data, only a stable reason and an empty results array', () => {
  assert.match(WORKER_CODE, /return \{ disabled: true, reason: guardFailed \? 'dispatch_guard_error' : 'dispatch_disabled', results: \[\] \};/);
});

test('a guard failure never re-throws a raw error and never logs err.message/stack', () => {
  const guardTryCatch = WORKER_CODE.match(/try \{\s*dispatchOk = await isDispatchEnabled\(\);\s*\} catch \(_err\) \{[\s\S]*?\}/);
  assert.ok(guardTryCatch, 'expected a try/catch specifically around the guard call');
  assert.ok(!/_err\.message|_err\.stack/.test(guardTryCatch[0]), 'the caught guard error must never be inspected or surfaced');
});

test('the dispatch guard is distinct from (and does not replace) the overlap/_ticking guard', () => {
  const tickingDecls = WORKER_CODE.match(/_ticking/g) || [];
  assert.ok(tickingDecls.length >= 3, 'the overlap guard must still be present alongside the new dispatch guard');
});

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

function channelWorkerBootBlock() {
  const start = INDEX_CODE.indexOf("CHANNEL_WORKER_ENABLED === 'true'");
  assert.ok(start >= 0, 'channel worker boot block not found in index.js');
  const end = INDEX_CODE.indexOf('channel queue worker disabled', start);
  assert.ok(end > start);
  return INDEX_CODE.slice(start, end);
}
const BOOT_BLOCK = channelWorkerBootBlock();

test('the boot path constructs isDispatchEnabled by reading CHANNEL_QUEUE_DISPATCH_ENABLED', () => {
  assert.match(BOOT_BLOCK, /CHANNEL_QUEUE_DISPATCH_ENABLED === 'true'/);
});

test('the boot path passes isDispatchEnabled into buildChannelQueueWorker', () => {
  assert.match(BOOT_BLOCK, /isDispatchEnabled,/);
  assert.match(BOOT_BLOCK, /buildChannelQueueWorker\(\{[\s\S]*?isDispatchEnabled[\s\S]*?\}\)/);
});

test('CHANNEL_WORKER_ENABLED remains the sole gate for whether the polling loop starts', () => {
  assert.match(INDEX_CODE, /CHANNEL_WORKER_ENABLED === 'true'/);
});

test('the boot path still constructs the worker with buildMockProcessor() only', () => {
  assert.match(BOOT_BLOCK, /buildMockProcessor\(\)/);
  assert.ok(!/buildRealProcessor/.test(BOOT_BLOCK));
});

test('realProcessor.js still exists but is imported nowhere in the boot path or the worker', () => {
  assert.ok(fs.existsSync(REALPROC_PATH));
  assert.ok(!/require\([^)]*realProcessor/i.test(INDEX_CODE));
  assert.ok(!/require\([^)]*realProcessor/i.test(WORKER_CODE));
});

test('CHANNEL_WORKER_REAL is not read, gated on, or introduced anywhere in the boot path', () => {
  assert.ok(!/CHANNEL_WORKER_REAL/.test(INDEX_CODE));
});

test('the boot path introduces no network-capable call and does not reference channelRegistry', () => {
  assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(BOOT_BLOCK));
  assert.ok(!/channelRegistry/.test(BOOT_BLOCK));
});

test('this phase introduces no role, migration, ownership or RLS/FORCE-RLS construct anywhere in its changes', () => {
  for (const forbidden of [
    /\bCREATE\s+ROLE\b/i, /\bALTER\s+ROLE\b/i, /\bDROP\s+ROLE\b/i,
    /\bGRANT\s+.*BYPASSRLS/i, /\bOWNER\s+TO\b/i,
    /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i,
    /\b(CREATE|DROP|ALTER)\s+(POLICY|TABLE)\b/i
  ]) {
    assert.ok(!forbidden.test(WORKER_CODE) && !forbidden.test(BOOT_BLOCK) && !forbidden.test(ENV_CODE),
      'unexpected forbidden construct: ' + forbidden);
  }
});

// ---------------------------------------------------------------------------
// Registry kill switch (availability/rate path) untouched
// ---------------------------------------------------------------------------

test('the existing channel registry kill switch (availability/rate path) is untouched by this phase', () => {
  const syncPath = path.join(__dirname, '..', 'src', 'channel-manager', 'sync', 'channelSyncService.js');
  const registryPath = path.join(__dirname, '..', 'src', 'channel-manager', 'registry', 'channelRegistryService.js');
  const syncSrc = fs.readFileSync(syncPath, 'utf8');
  assert.match(syncSrc, /channel_disabled/);
  assert.match(syncSrc, /reg\.enabled/);
  assert.ok(fs.existsSync(registryPath));
});
