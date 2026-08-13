'use strict';

/**
 * Phase 66A-B2N-D — static contract for migration 0089.
 *
 * The migration is read as TEXT and never executed. What it guards is a very
 * specific mistake: someone "simplifying" the bootstrap-plus-migration split by
 * moving the resolver's CREATE FUNCTION into the migration. That would produce
 * a function owned by the ordinary application role, which has no BYPASSRLS, so
 * SECURITY DEFINER would execute without RLS exemption and the resolver would
 * return ZERO rows forever. The drain worker would then report healthy idle
 * ticks while ARI events silently accumulated — worse than having no worker.
 *
 * These assertions make that edit impossible to land quietly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIG_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const MIG_PATH = path.join(MIG_DIR, '0089_ari_outbox_worker_resolver.sql');

test('migration basename is exactly 0089_ari_outbox_worker_resolver.sql and no other 0089 exists', () => {
  assert.ok(fs.existsSync(MIG_PATH));
  const zero89 = fs.readdirSync(MIG_DIR).filter((f) => /^0089_/.test(f));
  assert.deepEqual(zero89, ['0089_ari_outbox_worker_resolver.sql'],
    'exactly one 0089_* migration exists');
});

const SQL = fs.readFileSync(MIG_PATH, 'utf8');

/** Statement text with `--` comments stripped, so prose cannot satisfy an assertion. */
const CODE = SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

// ---------------------------------------------------------------------------
// A. It must NOT create the function
// ---------------------------------------------------------------------------

test('1. the migration creates NO function — the bootstrap is the only creation path', () => {
  assert.ok(!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(CODE),
    'a migration-created resolver would be owned by the app role, lack BYPASSRLS, '
    + 'and return zero rows forever under FORCE RLS');
  assert.ok(!/SET\s+(LOCAL\s+)?ROLE/i.test(CODE),
    'the migration runner cannot SET ROLE (42501) — attempting it would fail the migration');
  assert.ok(!/CREATE\s+SCHEMA/i.test(CODE), 'the worker_resolvers schema belongs to the bootstrap');
});

test('2. it documents WHY it cannot create the function', () => {
  const prose = SQL.replace(/\n--\s*/g, ' ').replace(/\s+/g, ' ');
  assert.match(prose, /THIS MIGRATION DOES NOT CREATE THE FUNCTION/i);
  assert.match(prose, /42501/, 'must cite the concrete PostgreSQL refusal');
  assert.match(prose, /BYPASSRLS/);
  assert.match(prose, /zero rows/i);
});

// ---------------------------------------------------------------------------
// B. The grant: exactly six columns, nothing more
// ---------------------------------------------------------------------------

const GRANTED = ['tenant_id', 'status', 'retry_count', 'max_retries', 'next_retry_at', 'lease_until'];

test('3. grants column-level SELECT on exactly the six predicate columns', () => {
  const m = CODE.match(/GRANT\s+SELECT\s*\(([^)]*)\)\s*\n?\s*ON\s+public\.ari_outbox_store/i);
  assert.ok(m, 'expected a column-level GRANT SELECT on public.ari_outbox_store');
  const cols = m[1].split(',').map((c) => c.trim()).filter(Boolean).sort();
  assert.deepEqual(cols, GRANTED.slice().sort(), 'exactly the six predicate columns');
});

test('4. the grant target is the existing resolver role, and no other', () => {
  assert.match(CODE, /TO\s+qyrvia_auth_resolver\s*;/i);
  assert.ok(!/TO\s+PUBLIC/i.test(CODE), 'PUBLIC must never receive a privilege here');
});

test('5. no table-wide SELECT and no write privilege is granted', () => {
  // A bare `GRANT SELECT ON` (no column list) would widen this to every column.
  assert.ok(!/GRANT\s+SELECT\s+ON\s/i.test(CODE), 'table-wide SELECT must never be granted');
  assert.ok(!/GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i.test(CODE),
    'the resolver is read-only by design');
});

test('6. no forbidden column is granted', () => {
  const m = CODE.match(/GRANT\s+SELECT\s*\(([^)]*)\)/i);
  const granted = m[1].split(',').map((c) => c.trim());
  for (const forbidden of ['payload_json', 'dedupe_key', 'event_type', 'resource_kind',
                           'property_id', 'room_type_id', 'rate_plan_id',
                           'restriction_rule_id', 'source_version', 'lease_owner',
                           'attempts', 'id', 'created_at', 'updated_at',
                           'completed_at', 'dead_lettered_at', 'effective_from',
                           'effective_to']) {
    assert.ok(!granted.includes(forbidden), 'must not grant ' + forbidden);
  }
});

// ---------------------------------------------------------------------------
// C. Postconditions
// ---------------------------------------------------------------------------

test('7. it fails closed when the resolver function is absent', () => {
  assert.match(CODE, /proname\s*=\s*'due_ari_outbox_tenants'/);
  assert.match(CODE, /does not exist\. Run the appropriate superuser bootstrap/i);
});

test('8. it proves the function returns TABLE(tenant_id uuid) only', () => {
  assert.match(CODE, /proretset\s*=\s*false/);
  assert.match(CODE, /proargnames\[2\]\s*<>\s*'tenant_id'/);
});

test('9. it proves owner, SECURITY DEFINER, STABLE and a fixed search_path', () => {
  // The owner is read into v_owner from pg_roles, then compared null-safely.
  assert.match(CODE, /JOIN\s+pg_roles\s+r\s+ON\s+r\.oid\s*=\s*p\.proowner/i);
  assert.match(CODE, /v_owner\s+IS\s+DISTINCT\s+FROM\s+'qyrvia_auth_resolver'/i);
  assert.match(CODE, /prosecdef\s*=\s*false/);
  assert.match(CODE, /provolatile\s*<>\s*'s'/);
  assert.match(CODE, /search_path=pg_catalog, public, pg_temp/);
});

test('10. it proves PUBLIC cannot execute and the app role can', () => {
  assert.match(CODE, /grantee\s*=\s*'PUBLIC'/);
  assert.match(CODE, /has_function_privilege\(current_user/i);
});

test('11. it proves the granted column set is EXACTLY the six, order-independently', () => {
  assert.match(CODE, /information_schema\.column_privileges/);
  assert.match(CODE, /ORDER\s+BY\s+cp\.column_name/i, 'sorted, so grant order cannot matter');
  assert.match(CODE, /IS\s+DISTINCT\s+FROM\s+v_expected/i);
  // The expected array must itself list exactly the six, sorted.
  const m = CODE.match(/v_expected\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/i);
  assert.ok(m, 'expected a v_expected ARRAY literal');
  const expected = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(expected, GRANTED.slice().sort());
});

test('12. it proves no table-wide and no write privilege leaked in', () => {
  assert.match(CODE, /role_table_grants/);
  assert.match(CODE, /table-wide\s+/i);
  assert.match(CODE, /'INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'/);
});

test('13. it proves the approved worker_resolvers set is exactly three', () => {
  assert.match(CODE, /expected exactly 3/i);
  assert.match(CODE, /'pending_channel_tenants',\s*'due_scheduler_tenants',\s*\n?\s*'due_ari_outbox_tenants'/);
});

test('14. it proves RLS, FORCE RLS and the tenant policy survive', () => {
  assert.match(CODE, /relrowsecurity/);
  assert.match(CODE, /relforcerowsecurity/);
  assert.match(CODE, /policyname\s*=\s*'ari_outbox_store_by_app'/);
  assert.match(CODE, /qual\s+IS\s+NOT\s+NULL\s+AND\s+with_check\s+IS\s+NOT\s+NULL/i);
});

test('15. it proves the 0087 and 0088 structural contracts are intact', () => {
  assert.match(CODE, /uq_aob_logical_event/);
  assert.match(CODE, /ari_outbox_store_property_same_tenant_fk/);
  assert.match(CODE, /ari_outbox_store_key_version_compat/);
  assert.match(CODE, /idx_aob_claim/);
  assert.match(CODE, /idx_aob_retry_due/);
  assert.match(CODE, /idx_aob_lease_expiry/);
  assert.match(CODE, /reservation_id/, 'must still assert reservation_id is absent');
});

test('16. it proves the resolver role attributes are unchanged', () => {
  assert.match(CODE, /rolcanlogin\s+OR\s+rolsuper\s+OR\s+NOT\s+rolbypassrls/i);
});

// ---------------------------------------------------------------------------
// D. Migration hygiene
// ---------------------------------------------------------------------------

test('17. no transaction control — migrate.js owns the transaction', () => {
  assert.ok(!/^\s*(COMMIT|ROLLBACK)\s*;/im.test(CODE), 'no COMMIT/ROLLBACK statement');
  // The only BEGIN permitted is the PL/pgSQL block opener of the DO $$ block.
  const begins = (CODE.match(/^\s*BEGIN\s*;/gim) || []);
  assert.deepEqual(begins, [], 'no transaction-control BEGIN;');
});

test('18. no DML, no backfill, no DDL beyond the grant', () => {
  assert.ok(!/^\s*(INSERT|UPDATE|DELETE)\s/im.test(CODE), 'no DML');
  // TRUNCATE appears ONLY as a quoted privilege name inside the postcondition's
  // write-privilege IN-list — an absence guard, not an executed statement. So
  // this checks for an unquoted TRUNCATE, which is what would actually run.
  assert.ok(!/(^|[^'])\bTRUNCATE\b([^']|$)/im.test(CODE), 'no TRUNCATE statement');
  assert.ok(!/\bCASCADE\b/i.test(CODE));
  assert.ok(!/ALTER\s+TABLE/i.test(CODE), 'this migration changes no table structure');
  assert.ok(!/CREATE\s+(TABLE|INDEX|POLICY)/i.test(CODE));
  assert.ok(!/DROP\s+/i.test(CODE));
});

test('19. it creates no role, grants no membership and no BYPASSRLS', () => {
  assert.ok(!/CREATE\s+ROLE|ALTER\s+ROLE|DROP\s+ROLE/i.test(CODE));
  assert.ok(!/\bGRANT\b[^;]*\bBYPASSRLS\b/i.test(CODE));
  assert.ok(!/OWNER\s+TO/i.test(CODE), 'no ownership change');
  assert.ok(!/DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(CODE));
});

test('20. it does not touch schema_migrations', () => {
  assert.ok(!/schema_migrations/i.test(CODE));
});

test('21. migrations 0001 through 0088 are unmodified by this phase', () => {
  // Content sentinels on the two immediate neighbours this phase depends on.
  const m87 = fs.readFileSync(path.join(MIG_DIR, '0087_ari_outbox.sql'), 'utf8');
  assert.match(m87, /CONSTRAINT uq_aob_logical_event\s*\n\s*UNIQUE \(tenant_id, property_id, dedupe_key\)/);
  const m88 = fs.readFileSync(path.join(MIG_DIR, '0088_ari_outbox_restriction_scope.sql'), 'utf8');
  assert.match(m88, /ADD COLUMN restriction_rule_id VARCHAR\(80\)/);
  assert.match(m88, /ari_outbox_store_key_version_compat/);
});

test('22. contains no credential and no connection string', () => {
  assert.ok(!/postgres(ql)?:\/\//i.test(SQL));
  assert.ok(!/\bPASSWORD\s+'/i.test(SQL));
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(SQL));
});
