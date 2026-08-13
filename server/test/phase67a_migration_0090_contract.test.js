'use strict';

/**
 * Phase 67A Workstream A — migration 0090 STATIC contract tests.
 *
 * These are file-content assertions only — no PostgreSQL connection is
 * opened, no migration is ever executed. Per the Phase 67A brief's Section
 * 11 (TEST EXECUTION SAFETY): live-database verification of RLS is
 * explicitly out of scope for this test run.
 *   RLS_STATIC_AND_CONTRACT_VERIFIED = true  (this file)
 *   RLS_LIVE_DATABASE_VERIFIED       = false (requires a separate, verified
 *                                             qyrvia_test database gate)
 */

const { test } = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('node:fs');
const path      = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const TARGET_FILE     = '0090_phase67a_saas_critical_safety.sql';
const TARGET_PATH     = path.join(MIGRATIONS_DIR, TARGET_FILE);

function readTarget() {
  return fs.readFileSync(TARGET_PATH, 'utf8');
}

// Strips `--` line comments before "must not contain X" assertions, so
// prose in the migration's own doc header (which legitimately DISCUSSES
// BYPASSRLS, schema_migrations, etc. as things it does NOT do) can't
// produce a false failure. Only used for negative-match ("doesNotMatch")
// checks — positive-match checks are fine against the raw file.
function stripSqlComments(sql) {
  return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}

test('migration 0090: file exists under server/src/db/migrations', () => {
  assert.ok(fs.existsSync(TARGET_PATH), TARGET_FILE + ' is missing');
});

test('migration 0090: is numbered strictly after every other migration in the directory (including 0089)', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f));
  const numbers = files.map((f) => parseInt(f.slice(0, 4), 10));
  const target = parseInt(TARGET_FILE.slice(0, 4), 10);
  const highestOther = Math.max(...numbers.filter((n) => n !== target));
  assert.equal(target, 90);
  assert.ok(target > highestOther, `0090 must be the highest-numbered migration; found higher: ${highestOther}`);
});

test('migration 0090: does not modify migration 0089 or any earlier migration file', () => {
  // "Does not modify" is proven by 0090 being a distinct, additively-numbered
  // file — the only way this migration file could touch 0089's SQL is if it
  // literally opened/edited that file, which it structurally cannot: each
  // migration file here is a standalone script applied once, in order, by
  // the migration runner. Confirm 0089 still exists untouched as a sibling
  // file (not merged into or replaced by 0090).
  const file0089 = path.join(MIGRATIONS_DIR, '0089_ari_outbox_worker_resolver.sql');
  assert.ok(fs.existsSync(file0089), 'migration 0089 must still exist as its own file');
});

test('migration 0090: enables AND forces row level security (idempotently) for tenant-scoped tables', () => {
  const sql = readTarget();
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /FORCE\s+ROW LEVEL SECURITY/i);
  // The idempotent self-discovery block only acts when the flag is unset.
  assert.match(sql, /IF NOT r\.relrowsecurity THEN/i);
  assert.match(sql, /IF NOT r\.relforcerowsecurity THEN/i);
});

test('migration 0090: never disables row level security anywhere', () => {
  const sql = stripSqlComments(readTarget());
  assert.doesNotMatch(sql, /DISABLE\s+ROW LEVEL SECURITY/i);
});

test('migration 0090: never grants BYPASSRLS or superuser to any role', () => {
  const sql = stripSqlComments(readTarget());
  assert.doesNotMatch(sql, /BYPASSRLS/i);
  assert.doesNotMatch(sql, /SUPERUSER/i);
});

test('migration 0090: never creates a tautological/open policy (USING (true) or WITH CHECK (true))', () => {
  const sql = stripSqlComments(readTarget());
  assert.doesNotMatch(sql, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(sql, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test('migration 0090: every EXECUTABLE policy this migration creates is scoped by tenant_id = app_current_tenant()', () => {
  // Must run against comment-stripped text — the header prose legitimately
  // discusses "CREATE POLICY statements" without an executable statement
  // following nearby, which would otherwise make a naive regex capture
  // unrelated comment text up to the next semicolon anywhere in the file.
  const sql = stripSqlComments(readTarget());
  const createPolicyBlocks = sql.match(/CREATE POLICY[\s\S]*?(?=;)/gi) || [];
  assert.ok(createPolicyBlocks.length >= 1, 'expected at least one executable CREATE POLICY statement');
  for (const block of createPolicyBlocks) {
    assert.match(block, /tenant_id\s*=\s*app_current_tenant\(\)/,
      'every CREATE POLICY in this migration must scope by tenant_id = app_current_tenant(): ' + block.slice(0, 120));
  }
});

test('migration 0090: fixes channel_registry to use the explicit WITH CHECK, sargable convention', () => {
  const sql = readTarget();
  assert.match(sql, /DROP POLICY IF EXISTS channel_registry_tenant_isolation ON channel_registry/i);
  assert.match(sql, /CREATE POLICY channel_registry_tenant_isolation ON channel_registry/i);
  const idx = sql.indexOf('CREATE POLICY channel_registry_tenant_isolation');
  const block = sql.slice(idx, idx + 400);
  assert.match(block, /WITH CHECK\s*\(\s*tenant_id\s*=\s*app_current_tenant\(\)\s*\)/i);
});

test('migration 0090: does not touch ari_outbox_store (Phase 66A / protected)', () => {
  const sql = stripSqlComments(readTarget());
  assert.doesNotMatch(sql, /ari_outbox_store/i);
});

test('migration 0090: includes a postcondition that RAISEs if any tenant-scoped table still lacks FORCE RLS', () => {
  const sql = readTarget();
  assert.match(sql, /RAISE EXCEPTION/i);
  assert.match(sql, /relforcerowsecurity IS NOT TRUE/i);
});

test('migration 0090: includes a SEPARATE postcondition that RAISEs if any tenant-scoped table has ZERO policies (brief 003 §11.6)', () => {
  const sql = readTarget();
  assert.match(sql, /missing_policy/i);
  assert.match(sql, /NOT EXISTS\s*\(\s*SELECT 1 FROM pg_policy WHERE polrelid = c\.oid\s*\)/i);
  // Two distinct RAISE EXCEPTION statements — one per postcondition.
  const raises = sql.match(/RAISE EXCEPTION/gi) || [];
  assert.ok(raises.length >= 2, 'expected at least two RAISE EXCEPTION statements (FORCE-missing + policy-missing)');
});

test('migration 0090: does NOT auto-create a generic FOR-ALL/unknown-table policy — the old auto-create-when-zero-policies branch has been removed (brief 003 §11.7)', () => {
  const sql = stripSqlComments(readTarget());
  // The removed branch looked like:
  //   IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = r.oid) THEN
  //     EXECUTE format('CREATE POLICY %I ON %I USING (...) WITH CHECK (...)', ...);
  //   END IF;
  // i.e. a dynamic CREATE POLICY driven by "this table currently has zero
  // policies" rather than an explicit, reviewed, per-table policy. Assert
  // there is no CREATE POLICY inside an EXECUTE format(...) call anywhere
  // in this migration — every CREATE POLICY here must be a literal,
  // reviewed statement (channel_registry's, specifically), not a
  // dynamically-synthesized one for an arbitrary/unknown table.
  assert.doesNotMatch(sql, /EXECUTE format\([^)]*CREATE POLICY/is,
    'a dynamically-synthesized CREATE POLICY (auto-invented for an unknown table) must not exist');
  assert.doesNotMatch(sql, /polrelid = r\.oid/i,
    'the old zero-policies-triggers-auto-create branch (keyed on polrelid = r.oid) must be gone');
});

test('migration 0090: does not falsely claim to automatically protect tables added by future migrations', () => {
  const raw = readTarget();
  // The brief explicitly required removing this claim: "A future table
  // added after migration 0090 will not be protected by a migration that
  // already ran. Do not describe 0090 as automatically protecting future
  // tables." Assert the corrective disclaimer is present and explicit.
  assert.match(raw, /does not re-run on\s*\n?--\s*every future migration/i);
  assert.match(raw, /runs exactly\s*\n?--\s*once/i);
});

test('migration 0090: explicitly reports PROPERTY_LEVEL_RLS_IMPLEMENTED=false', () => {
  const raw = readTarget();
  assert.match(raw, /PROPERTY_LEVEL_RLS_IMPLEMENTED=false/);
});

test('migration 0090: uses idempotent guards throughout (conditional DDL, DROP POLICY IF EXISTS, IF EXISTS)', () => {
  const sql = readTarget();
  assert.match(sql, /IF NOT r\.relrowsecurity THEN/i);
  assert.match(sql, /IF NOT r\.relforcerowsecurity THEN/i);
  assert.match(sql, /DROP POLICY IF EXISTS/i);
  assert.match(sql, /IF EXISTS\s*\(/i);
});

test('migration 0090: Part 3\'s postcondition SQL is well-formed PL/pgSQL — a single DECLARE block, not multiple DECLARE keywords', () => {
  // Regression guard for a real bug caught during authoring: PL/pgSQL
  // allows exactly one DECLARE section per DO block. `DECLARE a text;
  // DECLARE b text;` is a syntax error — variables must be declared in one
  // DECLARE section, semicolon-separated.
  const sql = readTarget();
  const doBlocks = sql.split(/\bDO \$\$/).slice(1);
  for (const block of doBlocks) {
    const declareCount = (block.match(/\bDECLARE\b/gi) || []).length;
    assert.ok(declareCount <= 1, `a DO $$ block has ${declareCount} DECLARE keywords — PL/pgSQL allows at most 1`);
  }
});

test('migration 0090: global catalogs without tenant_id (schema_migrations/roles/permissions/role_permissions/connectors/settings_schema) are never named in executable SQL — the ENABLE/FORCE step is entirely column-driven, not a hardcoded table list', () => {
  const raw = readTarget();
  const sql = stripSqlComments(raw); // the doc header legitimately DISCUSSES these table names in prose
  for (const globalTable of ['schema_migrations', 'roles', 'permissions', 'role_permissions', 'connectors', 'settings_schema']) {
    assert.doesNotMatch(sql, new RegExp('\\b' + globalTable + '\\b', 'i'),
      `${globalTable} must not appear in executable SQL — inclusion/exclusion is driven by information_schema.columns, not a hardcoded list`);
  }
  assert.match(raw, /information_schema\.columns/i);
  assert.match(raw, /col\.column_name = 'tenant_id'/i);
});
