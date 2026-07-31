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

test('the dispatch setting remains distinct from CHANNEL_WORKER_ENABLED and CHANNEL_WORKER_REAL (Phase 66A-B2L added CHANNEL_WORKER_REAL as its own third gate)', () => {
  assert.match(ENV_CODE, /CHANNEL_WORKER_ENABLED:\s*getOptional\('CHANNEL_WORKER_ENABLED',\s*'false'\)/);
  assert.match(ENV_CODE, /CHANNEL_WORKER_REAL:\s*getOptional\('CHANNEL_WORKER_REAL',\s*'false'\)/);
  // Three distinct getOptional('CHANNEL_...', 'false') call sites for the
  // three independent worker/dispatch/real-processor gates — none reused.
  const gateDeclarations = ENV_CODE.match(/getOptional\('CHANNEL_(WORKER_ENABLED|QUEUE_DISPATCH_ENABLED|WORKER_REAL)',\s*'false'\)/g) || [];
  assert.equal(gateDeclarations.length, 3);
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

test('the boot path selects buildMockProcessor by default; buildRealProcessor is constructed only inside the explicit CHANNEL_WORKER_REAL real-mode branch added in Phase 66A-B2L', () => {
  assert.match(BOOT_BLOCK, /buildMockProcessor\(\)/);
  const realGateIdx = BOOT_BLOCK.search(/CHANNEL_WORKER_REAL === 'true'/);
  const realCtorIdx = BOOT_BLOCK.search(/buildRealProcessor\(/);
  assert.ok(realGateIdx >= 0, 'expected an explicit CHANNEL_WORKER_REAL === \'true\' check');
  assert.ok(realCtorIdx > realGateIdx, 'buildRealProcessor must only be constructed after the real-mode gate');
});

test('realProcessor.js exists; imported conditionally in the boot path (Phase 66A-B2L) but never by the worker file itself', () => {
  assert.ok(fs.existsSync(REALPROC_PATH));
  assert.match(BOOT_BLOCK, /require\(['"]\.\/channel-manager\/worker\/realProcessor['"]\)/);
  assert.ok(!/require\([^)]*realProcessor/i.test(WORKER_CODE), 'channelQueueWorker.js must stay processor-agnostic');
});

test('CHANNEL_WORKER_REAL is read exactly in the boot path with a strict true-only comparison (Phase 66A-B2L)', () => {
  assert.match(INDEX_CODE, /CHANNEL_WORKER_REAL === 'true'/);
});

test('the boot path introduces no network-capable call; channelRegistry is referenced only to inject it into the real-mode processor (Phase 66A-B2L)', () => {
  assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(BOOT_BLOCK));
  assert.match(BOOT_BLOCK, /channelRegistry/);
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
