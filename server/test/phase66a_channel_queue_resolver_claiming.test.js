'use strict';

/**
 * Phase 66A-B2I — static contract test for the channel-queue tenant-bound
 * claiming fix (server/src/channel-manager/persistence/dbStores.js), the
 * P0-12 queue-claiming prerequisite. Mirrors
 * test/phase66a_scheduler_resolver_claiming.test.js (Phase 66A-B2H) for the
 * sibling scheduler fix.
 *
 * This test reads the source as TEXT and never executes it — it opens no
 * database connection, so it belongs to the flat `test/*.test.js` suite
 * (npm run test:unit), not test/db/. Live tenant-isolation, due-time
 * filtering, concurrency and post-migration security behaviour are covered
 * separately by test/db/phase66a_channel_queue_resolver_claiming.db.test.js.
 *
 * What this guards against: dequeuePendingAcrossTenants is the one place
 * that discovers channel-sync work across tenant boundaries. A careless
 * edit that reintroduces a bare, unscoped channel_sync_queue_store scan — or
 * that silently falls back to one when the resolver call fails, or that
 * weakens dequeue()'s own due-time/retry exclusion back to status-only —
 * reproduces the P0-12 discovery-side defect (silently claims nothing under
 * FORCE RLS) or a claim-side regression (claims a backing-off/exhausted
 * row a tenant was never actually "due" for). These assertions pin the
 * two-step discovery/claim shape so that cannot land quietly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORES_PATH = path.join(__dirname, '..', 'src', 'channel-manager', 'persistence', 'dbStores.js');
const SOURCE = fs.readFileSync(STORES_PATH, 'utf8');

/**
 * Statement text with `//` line comments stripped, so prose in a comment
 * cannot satisfy an assertion. CRLF-safe: on a Windows checkout each split
 * line can end in a bare `\r`, and `$` does not anchor before a lone `\r`
 * (only before a final `\n`), so the anchor is dropped — `.` already stops
 * at the `\r` on its own, giving the same result without the dead anchor.
 */
const CODE = SOURCE.split('\n')
  .map((l) => l.replace(/\/\/.*/, ''))
  .join('\n');

function fnBody(name, nextMarker) {
  const start = CODE.indexOf(name);
  assert.ok(start >= 0, name + ' not found in dbStores.js');
  const end = CODE.indexOf(nextMarker, start);
  assert.ok(end > start, 'could not bound ' + name + ' against ' + JSON.stringify(nextMarker));
  return CODE.slice(start, end);
}

const DEQUEUE_BODY = fnBody('async dequeue()', 'async markProcessing(id)');
// Bounded at the next sibling function (Phase 66A-B2J added
// markQueueCompletedForTenant/markQueueFailedForTenant directly after this
// one, before buildDeadLetterStoreDb) so this body contains only
// dequeuePendingAcrossTenants's own statements, not its neighbours'.
const ACROSS_TENANTS_BODY = fnBody('async function dequeuePendingAcrossTenants', 'async function markQueueCompletedForTenant');

// ---------------------------------------------------------------------------
// dequeue() itself — unchanged signature, aligned due-ness predicate
// ---------------------------------------------------------------------------

test('dequeue() still takes no arguments and still returns one row or null', () => {
  assert.match(CODE, /async dequeue\(\) \{/);
  assert.match(DEQUEUE_BODY, /return r\.rows\[0\] \|\| null;/);
});

test('dequeue() preserves the original status/order/lock clauses', () => {
  assert.match(DEQUEUE_BODY, /status = 'PENDING'/);
  assert.match(DEQUEUE_BODY, /ORDER BY created_at/);
  assert.match(DEQUEUE_BODY, /LIMIT 1/);
  assert.match(DEQUEUE_BODY, /FOR UPDATE SKIP LOCKED/);
  assert.match(DEQUEUE_BODY, /SET status = 'PROCESSING', updated_at = now\(\)/);
});

test('dequeue() now excludes backing-off and retry-exhausted rows, matching the resolver', () => {
  assert.match(DEQUEUE_BODY, /next_retry_at IS NULL OR next_retry_at <= now\(\)/);
  assert.match(DEQUEUE_BODY, /next_run_at   IS NULL OR next_run_at   <= now\(\)/);
  assert.match(DEQUEUE_BODY, /retry_count < max_retries/);
});

test('dequeue() runs on whatever db handle its caller supplies (unchanged handle-agnostic contract)', () => {
  assert.match(DEQUEUE_BODY, /await db\.query\(/);
  assert.ok(!/pool\.connect|runWithTenantTransaction/.test(DEQUEUE_BODY),
    'dequeue() itself must stay a plain, handle-agnostic query runner');
});

// ---------------------------------------------------------------------------
// Discovery — must go through the verified resolver, never a global scan
// ---------------------------------------------------------------------------

test('dequeuePendingAcrossTenants discovers tenants only through worker_resolvers.pending_channel_tenants', () => {
  assert.match(ACROSS_TENANTS_BODY, /worker_resolvers\.pending_channel_tenants\(\$1\)/);
});

test('the resolver discovery call is parameterized, not string-interpolated', () => {
  assert.match(ACROSS_TENANTS_BODY,
    /pool\.query\(\s*'SELECT tenant_id FROM worker_resolvers\.pending_channel_tenants\(\$1\)'\s*,\s*\[safeLimit\]\s*\)/);
  assert.ok(!/pending_channel_tenants\(\$\{/.test(ACROSS_TENANTS_BODY),
    'must not template-interpolate the limit into the SQL text');
});

test('the discovery query selects tenant_id only', () => {
  const call = ACROSS_TENANTS_BODY.match(/SELECT ([^\n]*?) FROM worker_resolvers\.pending_channel_tenants/);
  assert.ok(call);
  assert.equal(call[1].trim(), 'tenant_id');
});

test('dequeuePendingAcrossTenants contains no bare/unscoped channel_sync_queue_store discovery scan', () => {
  const uowAt = ACROSS_TENANTS_BODY.search(/runWithTenantTransaction\(pool, tenantId, \(client\) =>/);
  assert.ok(uowAt >= 0, 'expected runWithTenantTransaction(pool, tenantId, (client) => ...)');
  const beforeUow = ACROSS_TENANTS_BODY.slice(0, uowAt);
  assert.ok(!/channel_sync_queue_store/i.test(beforeUow),
    'a channel_sync_queue_store reference appears before the tenant-bound unit of work opens');
  assert.ok(!/pool\.query\([^)]*channel_sync_queue_store/is.test(ACROSS_TENANTS_BODY),
    'channel_sync_queue_store must never be queried directly on the bare pool');
});

test('the per-tenant claim reuses the unchanged dequeue() method via a tenant-scoped store instance', () => {
  assert.match(ACROSS_TENANTS_BODY, /buildSyncQueueStoreDb\(\{ db: client \}\)\.dequeue\(\)/);
});

// ---------------------------------------------------------------------------
// Tenant binding
// ---------------------------------------------------------------------------

test('dequeuePendingAcrossTenants uses the canonical tenant-bound unit of work', () => {
  assert.match(ACROSS_TENANTS_BODY, /runWithTenantTransaction\(pool, tenantId, \(client\) =>/);
});

test('runWithTenantTransaction is imported from tenantUnitOfWork, not reimplemented', () => {
  assert.match(CODE, /const \{ runWithTenantTransaction \} = require\('\.\.\/\.\.\/db\/tenantUnitOfWork'\);/);
});

test('dequeuePendingAcrossTenants never uses SET (session-wide) — only the transaction-local unit of work', () => {
  assert.ok(!/\bSET\s+app\.tenant_id\b/i.test(ACROSS_TENANTS_BODY));
  assert.ok(!/\bSET\s+LOCAL\s+ROLE\b/i.test(ACROSS_TENANTS_BODY));
  assert.ok(!/\bSET\s+ROLE\b/i.test(ACROSS_TENANTS_BODY));
});

test('dequeuePendingAcrossTenants opens exactly one unit of work per resolved tenant, inside the loop', () => {
  const forAt = ACROSS_TENANTS_BODY.search(/for \(const tenantId of tenantIds\)/);
  const uowAt = ACROSS_TENANTS_BODY.search(/runWithTenantTransaction\(/);
  assert.ok(forAt >= 0 && uowAt > forAt, 'runWithTenantTransaction must be called inside the per-tenant loop');
  const uowCalls = ACROSS_TENANTS_BODY.match(/runWithTenantTransaction\(/g) || [];
  assert.equal(uowCalls.length, 1, 'exactly one call site, executed once per loop iteration');
});

test('requires a real pool (with connect()), refusing a bare query-only handle', () => {
  assert.match(ACROSS_TENANTS_BODY, /typeof pool\.connect !== 'function'/);
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test('duplicate tenant IDs from discovery cannot cause duplicate tenant processing', () => {
  assert.match(ACROSS_TENANTS_BODY, /new Set\(discovery\.rows\.map\(\(row\) => row\.tenant_id\)\)/);
});

// ---------------------------------------------------------------------------
// Limit handling
// ---------------------------------------------------------------------------

test('the resolver limit is clamped into the 1..1000 bound the DB function itself enforces', () => {
  assert.match(ACROSS_TENANTS_BODY, /MIN_RESOLVER_LIMIT = 1;/);
  assert.match(ACROSS_TENANTS_BODY, /MAX_RESOLVER_LIMIT = 1000;/);
  assert.match(ACROSS_TENANTS_BODY, /Math\.max\(MIN_RESOLVER_LIMIT, Math\.min\(MAX_RESOLVER_LIMIT, requested\)\)/);
});

test('an invalid (non-positive-integer) limit falls back to a safe default rather than throwing before the resolver is even called', () => {
  assert.match(ACROSS_TENANTS_BODY, /Number\.isInteger\(limit\) && limit > 0 \? limit : 25/);
});

// ---------------------------------------------------------------------------
// Failure isolation and safe-error-path
// ---------------------------------------------------------------------------

test('no unsafe fallback exists: dequeuePendingAcrossTenants contains no catch/try around the resolver or claim calls', () => {
  assert.ok(!/\btry\s*\{/.test(ACROSS_TENANTS_BODY),
    'a try/catch here would risk swallowing a resolver or claim failure into a silent fallback');
  assert.ok(!/\.catch\(/.test(ACROSS_TENANTS_BODY));
});

test('dequeuePendingAcrossTenants never falls back to a direct global channel_sync_queue_store scan', () => {
  assert.ok(!/pool\.query\(\s*`?\s*(WITH|SELECT|UPDATE)[^)]*channel_sync_queue_store/is.test(ACROSS_TENANTS_BODY));
});

// ---------------------------------------------------------------------------
// Return contract
// ---------------------------------------------------------------------------

test('dequeuePendingAcrossTenants returns a flat array of claimed rows, at most one per tenant', () => {
  assert.match(ACROSS_TENANTS_BODY, /const claimed = \[\];/);
  assert.match(ACROSS_TENANTS_BODY, /if \(row\) claimed\.push\(row\);/);
  assert.match(ACROSS_TENANTS_BODY, /return claimed;/);
});

// ---------------------------------------------------------------------------
// No role, migration or RLS modification; no dispatch introduced
// ---------------------------------------------------------------------------

test('this change introduces no role, ownership, or RLS/FORCE RLS modification', () => {
  for (const forbidden of [
    /\bCREATE\s+ROLE\b/i, /\bALTER\s+ROLE\b/i, /\bDROP\s+ROLE\b/i,
    /\bGRANT\s+.*BYPASSRLS/i, /\bOWNER\s+TO\b/i,
    /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i,
    /\b(CREATE|DROP|ALTER)\s+POLICY\b/i
  ]) {
    assert.ok(!forbidden.test(ACROSS_TENANTS_BODY), 'unexpected forbidden construct: ' + forbidden);
  }
});

test('this change introduces no schema/migration DDL and no CREATE TABLE', () => {
  assert.ok(!/\bCREATE\s+TABLE\b/i.test(CODE));
  assert.ok(!/\bALTER\s+TABLE\b/i.test(CODE));
});

test('no real network/provider dispatch and no dispatch-guard reference is introduced', () => {
  assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(CODE));
  assert.ok(!/CHANNEL_WORKER_REAL/.test(CODE));
  assert.ok(!/channelRegistry/.test(CODE));
});

// ---------------------------------------------------------------------------
// Existing dead-letter/enqueue methods untouched
// ---------------------------------------------------------------------------

test('enqueue(), markProcessing/Completed/Failed and the dead-letter store are byte-identical to before', () => {
  assert.match(CODE, /ON CONFLICT \(tenant_id, reservation_id, action, COALESCE\(channel, ''\)\) WHERE status = 'PENDING'/);
  assert.match(CODE, /UPDATE channel_sync_queue_store SET status='COMPLETED', updated_at=now\(\) WHERE id=\$1/);
  assert.match(CODE, /UPDATE channel_sync_queue_store SET status='FAILED', attempts=attempts\+1, updated_at=now\(\) WHERE id=\$1/);
  assert.match(CODE, /ON CONFLICT \(tenant_id, reservation_id, action, dedupe_generation\)/);
});
