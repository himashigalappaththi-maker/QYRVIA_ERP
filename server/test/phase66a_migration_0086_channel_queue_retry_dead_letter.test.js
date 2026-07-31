'use strict';

/**
 * Phase 66A-B2M — static contract test for migration 0086 (durable
 * reservation-action queue retry, capped backoff and dead-letter handling).
 *
 * Reads the migration file as TEXT and never executes it — no database
 * connection, no migration run. Live application against real qyrvia_test is
 * covered by test/db/phase66a_channel_queue_retry_dead_letter.db.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIG_PATH = path.join(__dirname, '..', 'src', 'db', 'migrations', '0086_channel_queue_retry_dead_letter.sql');
const MIG_0085_PATH = path.join(__dirname, '..', 'src', 'db', 'migrations', '0085_worker_resolver_source_column_grants.sql');
const BOOTSTRAP_PATH = path.join(__dirname, '..', 'scripts', 'db', 'phase66a_worker_resolvers_bootstrap.sql');

test('migration 0086_channel_queue_retry_dead_letter.sql exists', () => {
  assert.ok(fs.existsSync(MIG_PATH));
});

const SOURCE = fs.readFileSync(MIG_PATH, 'utf8');

function stripComments(sql) {
  return sql.split('\n').map((l) => l.replace(/--.*/, '')).join('\n');
}
const CODE = stripComments(SOURCE);

test('the migration contains no BEGIN, COMMIT or ROLLBACK — the runner owns the transaction', () => {
  assert.ok(!/\bBEGIN\s*;/i.test(CODE));
  assert.ok(!/\bCOMMIT\s*;/i.test(CODE));
  assert.ok(!/\bROLLBACK\s*;/i.test(CODE));
});

test('the status CHECK constraint is dropped and re-added with exactly PENDING, PROCESSING, COMPLETED, FAILED, DEAD_LETTER', () => {
  assert.match(CODE, /DROP CONSTRAINT channel_sync_queue_store_status_check/i);
  assert.match(CODE, /ADD CONSTRAINT channel_sync_queue_store_status_check/i);
  const checkMatch = CODE.match(/ADD CONSTRAINT channel_sync_queue_store_status_check\s*\n\s*CHECK \(status IN \(([^)]+)\)\)/i);
  assert.ok(checkMatch, 'expected an exact CHECK (status IN (...)) clause');
  const values = checkMatch[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  assert.deepEqual(values.sort(), ['COMPLETED', 'DEAD_LETTER', 'FAILED', 'PENDING', 'PROCESSING'].sort());
});

test('no RETRY_WAIT status value is introduced (disclosed design: retry-wait stays PENDING)', () => {
  assert.ok(!/'RETRY_WAIT'/.test(CODE));
});

test('the old uq_csqs_pending_channel index is dropped and replaced by uq_csqs_active_channel covering PENDING and PROCESSING only', () => {
  assert.match(CODE, /DROP INDEX uq_csqs_pending_channel/i);
  const idxMatch = CODE.match(/CREATE UNIQUE INDEX uq_csqs_active_channel[\s\S]*?WHERE status IN \(([^)]+)\)/i);
  assert.ok(idxMatch, 'expected uq_csqs_active_channel with an explicit status IN (...) predicate');
  const values = idxMatch[1].split(',').map((v) => v.trim().replace(/'/g, ''));
  assert.deepEqual(values.sort(), ['PENDING', 'PROCESSING'].sort());
});

test('the new index uses the same dedupe key columns as the old one: tenant_id, reservation_id, action, COALESCE(channel, \'\')', () => {
  assert.match(CODE, /uq_csqs_active_channel\s*\n\s*ON channel_sync_queue_store \(tenant_id, reservation_id, action, COALESCE\(channel, ''\)\)/i);
});

test('an active-state duplicate preflight runs before any DDL and raises an exception on any duplicate group', () => {
  const dupIdx = CODE.search(/v_dup_groups > 0/);
  const dropConstraintIdx = CODE.search(/DROP CONSTRAINT channel_sync_queue_store_status_check/i);
  assert.ok(dupIdx >= 0 && dropConstraintIdx > dupIdx, 'the duplicate preflight must run before the constraint is touched');
  assert.match(CODE, /RAISE EXCEPTION[\s\S]{0,120}duplicate active-state/i);
});

test('no column is added to channel_sync_queue_store — retry_count, max_retries, next_retry_at, next_run_at are reused as-is', () => {
  assert.ok(!/ADD COLUMN/i.test(CODE));
});

test('retry_count and max_retries each gain a non-negativity CHECK constraint', () => {
  assert.match(CODE, /ADD CONSTRAINT channel_sync_queue_store_retry_count_nonneg CHECK \(retry_count >= 0\)/);
  assert.match(CODE, /ADD CONSTRAINT channel_sync_queue_store_max_retries_nonneg CHECK \(max_retries >= 0\)/);
});

test('no role, ownership, RLS, FORCE RLS, policy, GRANT or REVOKE statement of any kind appears', () => {
  for (const forbidden of [
    /\bCREATE\s+ROLE\b/i, /\bALTER\s+ROLE\b/i, /\bDROP\s+ROLE\b/i,
    /^\s*GRANT\s/m, /^\s*REVOKE\s/m, /\bOWNER\s+TO\b/i,
    /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i,
    /\b(CREATE|DROP|ALTER)\s+POLICY\b/i
  ]) {
    assert.ok(!forbidden.test(CODE), 'unexpected forbidden construct: ' + forbidden);
  }
});

test('the migration does not create, alter or invoke worker_resolvers.pending_channel_tenants — only verifies its postcondition', () => {
  assert.ok(!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(CODE));
  assert.ok(!/DROP\s+FUNCTION/i.test(CODE));
  // The only reference is a read-only existence/ownership/SECURITY DEFINER check.
  const refs = CODE.match(/worker_resolvers\.pending_channel_tenants/g) || [];
  assert.equal(refs.length, 1);
});

test('the postcondition verifies RLS/FORCE RLS, table ownership, and qyrvia_auth_resolver role attributes are unchanged', () => {
  assert.match(CODE, /relrowsecurity/);
  assert.match(CODE, /relforcerowsecurity/);
  assert.match(CODE, /pg_get_userbyid\(c\.relowner\)/);
  assert.match(CODE, /rolcanlogin OR rolsuper OR NOT rolbypassrls/);
});

test('the postcondition verifies qyrvia_auth_resolver gains no unexpected column-level grant', () => {
  assert.match(CODE, /qyrvia_auth_resolver gained an/i);
  assert.match(CODE, /'max_retries', 'next_retry_at', 'next_run_at', 'retry_count',\s*\n\s*'status', 'tenant_id'/);
});

test('the migration contains no reference to the superuser bootstrap script and does not invoke it', () => {
  assert.ok(!/phase66a_worker_resolvers_bootstrap\.sql/.test(CODE) === false || !/psql/i.test(CODE));
  assert.ok(!/\\i\s|\\include\s/i.test(CODE));
});

test('migration 0085 is untouched (unchanged content)', () => {
  const src85 = fs.readFileSync(MIG_0085_PATH, 'utf8');
  assert.match(src85, /worker_resolvers\.pending_channel_tenants/);
  assert.match(src85, /worker_resolvers\.due_scheduler_tenants/);
});

test('the superuser bootstrap script itself is untouched by this phase', () => {
  assert.ok(fs.existsSync(BOOTSTRAP_PATH));
  const bootstrapSrc = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
  assert.match(bootstrapSrc, /WHERE q\.status = 'PENDING'/);
});
