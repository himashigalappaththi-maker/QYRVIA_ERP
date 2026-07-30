'use strict';

/**
 * Phase 66A-B2H — static contract test for schedulerRepo.claimDueJobs()
 * (server/src/db/repos.js), the fix for P0-14.
 *
 * This test reads the source as TEXT and never executes it — it opens no
 * database connection, so it belongs to the flat `test/*.test.js` suite
 * (npm run test:unit), not test/db/. Live tenant-isolation, concurrency and
 * post-migration security behaviour are covered separately by
 * test/db/phase66a_scheduler_resolver_claiming.db.test.js, which requires a
 * real Postgres connection and therefore cannot live in this file without
 * breaking the project's existing two-tier test-running convention (a
 * `test:unit` run must never touch a database).
 *
 * What this guards against: claimDueJobs is the one place in the repo layer
 * that discovers work across tenant boundaries. A careless edit that
 * reintroduces a bare, unscoped `scheduled_jobs` scan — or that silently
 * falls back to one when the resolver call fails — reproduces P0-14 (the
 * scheduler silently claims nothing under FORCE RLS) or, worse, requires
 * BYPASSRLS/superuser to "work", which would defeat tenant isolation
 * entirely. These assertions pin the two-step discovery/claim shape so that
 * cannot land quietly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPOS_PATH = path.join(__dirname, '..', 'src', 'db', 'repos.js');
const SOURCE = fs.readFileSync(REPOS_PATH, 'utf8');

/** Statement text with `//` line comments stripped, so prose in a comment cannot satisfy an assertion. */
const CODE = SOURCE.split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

/** Isolate the claimDueJobs method body — bounded to the next sibling method in schedulerRepo. */
function claimDueJobsBody() {
  const start = CODE.indexOf('async claimDueJobs(');
  assert.ok(start >= 0, 'claimDueJobs not found in repos.js');
  const nextMethod = CODE.indexOf('async markJobCompleted(', start);
  assert.ok(nextMethod > start, 'could not bound claimDueJobs body against its next sibling method');
  return CODE.slice(start, nextMethod);
}

const BODY = claimDueJobsBody();

// ---------------------------------------------------------------------------
// Discovery — must go through the verified resolver, never a global scan
// ---------------------------------------------------------------------------

test('claimDueJobs discovers tenants only through worker_resolvers.due_scheduler_tenants', () => {
  assert.match(BODY, /worker_resolvers\.due_scheduler_tenants\(\$1\)/);
});

test('the resolver discovery call is parameterized, not string-interpolated', () => {
  // A parameterized pg call passes params as a second array argument to
  // pool.query — the SQL text itself contains only the placeholder $1, never
  // a template-interpolated value.
  const discoveryCallMatch = BODY.match(/pool\.query\(\s*'SELECT tenant_id FROM worker_resolvers\.due_scheduler_tenants\(\$1\)'\s*,\s*\[safeLimit\]\s*\)/);
  assert.ok(discoveryCallMatch, 'expected pool.query(<literal string with $1>, [safeLimit])');
  assert.ok(!/due_scheduler_tenants\(\$\{/.test(BODY), 'must not template-interpolate the limit into the SQL text');
});

test('the discovery query selects tenant_id only — no job id, no payload column', () => {
  const call = BODY.match(/SELECT ([^\n]*?) FROM worker_resolvers\.due_scheduler_tenants/);
  assert.ok(call);
  assert.equal(call[1].trim(), 'tenant_id');
});

test('claimDueJobs contains no bare/unscoped scheduled_jobs discovery scan', () => {
  // The only `scheduled_jobs` reference in this method must be the one query
  // that runs INSIDE runWithTenantTransaction's callback (i.e. after the
  // callback's opening `(client) => {`), never a bare pool.query against
  // scheduled_jobs at the top level of the method.
  const uowAt = BODY.search(/runWithTenantTransaction\(pool, tenantId, async \(client\) => \{/);
  assert.ok(uowAt >= 0, 'expected runWithTenantTransaction(pool, tenantId, async (client) => {...})');
  const beforeUow = BODY.slice(0, uowAt);
  assert.ok(!/scheduled_jobs/i.test(beforeUow),
    'a scheduled_jobs reference appears before the tenant-bound unit of work opens');
  assert.ok(!/pool\.query\([^)]*scheduled_jobs/is.test(BODY),
    'scheduled_jobs must never be queried directly on the bare pool');
});

test('exactly one query is issued per tenant, using the tenant-bound client', () => {
  const clientQueryCalls = BODY.match(/\bclient\.query\(/g) || [];
  assert.equal(clientQueryCalls.length, 1, 'expected exactly one client.query call inside the unit of work');
});

// ---------------------------------------------------------------------------
// Tenant binding
// ---------------------------------------------------------------------------

test('claimDueJobs uses the canonical tenant-bound unit of work (runWithTenantTransaction)', () => {
  assert.match(BODY, /runWithTenantTransaction\(pool, tenantId, async \(client\)/);
});

test('runWithTenantTransaction is imported from tenantUnitOfWork, not reimplemented', () => {
  assert.match(CODE, /runWithTenantTransaction\s*\n?\s*\} = require\('\.\/tenantUnitOfWork'\)/s);
});

test('claimDueJobs never uses SET (session-wide) — only the transaction-local unit of work', () => {
  assert.ok(!/\bSET\s+app\.tenant_id\b/i.test(BODY), 'session-wide SET would leak app.tenant_id beyond one transaction');
  assert.ok(!/\bSET\s+LOCAL\s+ROLE\b/i.test(BODY));
  assert.ok(!/\bSET\s+ROLE\b/i.test(BODY));
});

test('claimDueJobs opens exactly one unit of work per resolved tenant, inside the loop', () => {
  const forAt = BODY.search(/for \(const tenantId of tenantIds\)/);
  const uowAt = BODY.search(/runWithTenantTransaction\(/);
  assert.ok(forAt >= 0 && uowAt > forAt, 'runWithTenantTransaction must be called inside the per-tenant loop');
  const uowCalls = BODY.match(/runWithTenantTransaction\(/g) || [];
  assert.equal(uowCalls.length, 1, 'exactly one call site, executed once per loop iteration');
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test('duplicate tenant IDs from discovery cannot cause duplicate tenant processing', () => {
  assert.match(BODY, /new Set\(discovery\.rows\.map\(\(row\) => row\.tenant_id\)\)/);
});

// ---------------------------------------------------------------------------
// Claim SQL — locking, ordering, status transition preserved
// ---------------------------------------------------------------------------

test('the claim SQL preserves FOR UPDATE SKIP LOCKED', () => {
  assert.match(BODY, /FOR UPDATE SKIP LOCKED/);
});

test('the claim SQL preserves ORDER BY run_at and a parameterized LIMIT', () => {
  assert.match(BODY, /ORDER BY run_at\s*\n\s*LIMIT \$1/);
});

test('the claim SQL preserves the pending -> running status transition and lock fields', () => {
  assert.match(BODY, /WHERE status='pending' AND run_at <= now\(\)/);
  assert.match(BODY, /SET status='running'::scheduled_job_status,\s*\n\s*locked_by=\$2, locked_at=now\(\), started_at=now\(\),\s*\n\s*attempts=sj\.attempts\+1/);
});

test('the claim SQL preserves its original RETURNING contract (full row)', () => {
  assert.match(BODY, /RETURNING sj\.\*/);
});

test('claimDueJobs still returns a flat array of claimed rows (unchanged return contract)', () => {
  assert.match(BODY, /const claimed = \[\];/);
  assert.match(BODY, /claimed\.push\(\.\.\.rows\);/);
  assert.match(BODY, /return claimed;\s*\n\s*\},/);
});

// ---------------------------------------------------------------------------
// Limit handling
// ---------------------------------------------------------------------------

test('the resolver limit is clamped into the 1..1000 bound the DB function itself enforces', () => {
  assert.match(BODY, /MIN_RESOLVER_LIMIT = 1;/);
  assert.match(BODY, /MAX_RESOLVER_LIMIT = 1000;/);
  assert.match(BODY, /Math\.max\(MIN_RESOLVER_LIMIT, Math\.min\(MAX_RESOLVER_LIMIT, requested\)\)/);
});

test('an invalid (non-positive-integer) limit falls back to a safe default rather than throwing before the resolver is even called', () => {
  assert.match(BODY, /Number\.isInteger\(limit\) && limit > 0 \? limit : 25/);
});

// ---------------------------------------------------------------------------
// Failure isolation and safe-error-path
// ---------------------------------------------------------------------------

test('no unsafe fallback exists: claimDueJobs contains no catch/try around the resolver or claim calls', () => {
  assert.ok(!/\btry\s*\{/.test(BODY), 'a try/catch here would risk swallowing a resolver or claim failure into a silent fallback');
  assert.ok(!/\.catch\(/.test(BODY));
});

test('claimDueJobs never falls back to a direct global scheduled_jobs scan on any condition', () => {
  assert.ok(!/pool\.query\(\s*`?\s*(WITH|SELECT|UPDATE)[^)]*scheduled_jobs/is.test(BODY),
    'no variant of the old global claim query may remain reachable from the bare pool');
});

// ---------------------------------------------------------------------------
// No role, migration or RLS modification introduced by this change
// ---------------------------------------------------------------------------

test('this change introduces no role, ownership, or RLS/FORCE RLS modification', () => {
  for (const forbidden of [
    /\bCREATE\s+ROLE\b/i, /\bALTER\s+ROLE\b/i, /\bDROP\s+ROLE\b/i,
    /\bGRANT\s+.*BYPASSRLS/i, /\bOWNER\s+TO\b/i,
    /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i,
    /\b(CREATE|DROP|ALTER)\s+POLICY\b/i
  ]) {
    assert.ok(!forbidden.test(BODY), 'unexpected forbidden construct in claimDueJobs: ' + forbidden);
  }
});

test('this change introduces no schema migration reference (no CREATE/ALTER of any table or migration file)', () => {
  assert.ok(!/\bCREATE\s+TABLE\b/i.test(BODY));
  assert.ok(!/\bALTER\s+TABLE\b/i.test(BODY));
});

// ---------------------------------------------------------------------------
// Direct callers unchanged — the resolver rewiring must be invisible to them
// ---------------------------------------------------------------------------

test('scheduler.js still calls claimDueJobs with the same { workerId, limit } shape', () => {
  const schedulerPath = path.join(__dirname, '..', 'src', 'core', 'scheduler.js');
  const schedulerSrc = fs.readFileSync(schedulerPath, 'utf8');
  assert.match(schedulerSrc, /repo\.claimDueJobs\(\{\s*workerId:\s*WORKER_ID,\s*limit\s*\}\)/);
});

test('scheduler.js was not modified to add a fallback or bypass around claimDueJobs', () => {
  const schedulerPath = path.join(__dirname, '..', 'src', 'core', 'scheduler.js');
  const schedulerSrc = fs.readFileSync(schedulerPath, 'utf8');
  assert.ok(!/due_scheduler_tenants/.test(schedulerSrc),
    'the resolver call belongs only inside repos.js; scheduler.js must remain resolver-agnostic');
});
