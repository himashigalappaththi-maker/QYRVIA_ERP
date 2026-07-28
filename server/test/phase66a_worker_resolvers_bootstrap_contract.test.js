'use strict';

/**
 * Phase 66A-B1 — static contract test for the worker-resolvers bootstrap.
 *
 * This test reads the SQL as TEXT and never executes it. That is deliberate:
 * the script requires a PostgreSQL superuser, and a test suite must never be
 * able to escalate privilege as a side effect of running.
 *
 * What it is guarding against is a specific failure mode. The script's whole
 * purpose is to hand a BYPASSRLS definer context to two functions, so the
 * blast radius of a careless edit is "a worker can read every tenant's data".
 * These assertions pin the security contract so that edit cannot land quietly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'db', 'phase66a_worker_resolvers_bootstrap.sql');
const SQL = fs.readFileSync(SCRIPT_PATH, 'utf8');

/** Statement text with `--` comments stripped, so prose cannot satisfy an assertion. */
const CODE = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

// ---------------------------------------------------------------------------
// Existence and shape
// ---------------------------------------------------------------------------

test('the bootstrap script exists at the expected path', () => {
  assert.ok(fs.existsSync(SCRIPT_PATH));
  assert.ok(SQL.length > 2000, 'a bootstrap this security-sensitive should not be a stub');
});

// ---------------------------------------------------------------------------
// It must NOT create or alter privilege
// ---------------------------------------------------------------------------

test('creates no database role', () => {
  assert.ok(!/\bCREATE\s+ROLE\b/i.test(CODE), 'this script must reuse the Phase 62 roles');
});

test('alters no database role', () => {
  assert.ok(!/\bALTER\s+ROLE\b/i.test(CODE),
    'altering a role attribute to make a prerequisite pass would defeat the prerequisite');
});

test('drops no role and no schema', () => {
  assert.ok(!/\bDROP\s+ROLE\b/i.test(CODE));
  assert.ok(!/\bDROP\s+SCHEMA\b/i.test(CODE), 'DROP SCHEMA appears only in the rollback comment');
});

test('grants no role membership', () => {
  // `GRANT <role> TO <role>` — membership. Distinguished from privilege grants,
  // which always name a privilege keyword.
  const membership = CODE.match(/\bGRANT\s+(?!ALL|EXECUTE|USAGE|CREATE|SELECT|INSERT|UPDATE|DELETE|REFERENCES|TRIGGER|TEMP|TEMPORARY|CONNECT)[a-z_"][\w"]*\s+TO\b/gi) || [];
  assert.deepEqual(membership, [],
    'membership in qyrvia_auth_resolver would give the member BYPASSRLS via SET ROLE');
});

test('grants BYPASSRLS to nothing', () => {
  assert.ok(!/\bBYPASSRLS\b/.test(CODE) || !/\bGRANT\b[^;]*\bBYPASSRLS\b/i.test(CODE),
    'BYPASSRLS may only be READ as a prerequisite, never granted');
  // Every BYPASSRLS mention in executable code must be a read of role metadata.
  const lines = CODE.split('\n').filter((l) => /BYPASSRLS/i.test(l));
  for (const l of lines) {
    assert.ok(/rolbypassrls/i.test(l) || /must (already have|NOT have)/i.test(l),
      'unexpected BYPASSRLS usage: ' + l.trim().slice(0, 100));
  }
});

test('uses no CASCADE anywhere in executable SQL', () => {
  assert.ok(!/\bCASCADE\b/i.test(CODE),
    'CASCADE could silently destroy objects this script does not own');
});

// ---------------------------------------------------------------------------
// It must reuse the established Phase 62 identities
// ---------------------------------------------------------------------------

test('reuses the existing Phase 62 privileged roles by name', () => {
  assert.ok(/qyrvia_auth_resolver/.test(CODE), 'function owner');
  assert.ok(/qyrvia_auth_schema_owner/.test(CODE), 'schema owner');
});

test('creates the isolated worker_resolvers schema, owned by the NON-bypassrls role', () => {
  assert.match(CODE, /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+worker_resolvers/i);
  assert.match(CODE, /ALTER\s+SCHEMA\s+worker_resolvers\s+OWNER\s+TO\s+qyrvia_auth_schema_owner/i);
  assert.ok(!/ALTER\s+SCHEMA\s+worker_resolvers\s+OWNER\s+TO\s+qyrvia_auth_resolver/i.test(CODE),
    'the BYPASSRLS role must own functions only, never the schema');
});

test('the auth_resolvers schema is not touched', () => {
  assert.ok(!/CREATE\s+SCHEMA[^;]*auth_resolvers\b(?!_)/i.test(CODE.replace(/worker_resolvers/g, 'X')),
    'this phase must not modify the authentication resolver schema');
});

// ---------------------------------------------------------------------------
// The two functions
// ---------------------------------------------------------------------------

const FUNCS = ['pending_channel_tenants', 'due_scheduler_tenants'];

test('declares exactly the two approved function signatures', () => {
  const decls = CODE.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+worker_resolvers\.(\w+)\s*\(([^)]*)\)/gi) || [];
  assert.equal(decls.length, 2, 'exactly two functions, got ' + decls.length);
  for (const fn of FUNCS) {
    assert.ok(new RegExp('CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+worker_resolvers\\.' + fn +
      '\\s*\\(\\s*p_limit\\s+integer\\s*\\)', 'i').test(CODE), fn + ' signature');
  }
});

/** The two CREATE OR REPLACE declaration blocks, header through `AS $$`. */
function declBlocks() {
  const blocks = CODE.match(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+worker_resolvers\.\w+[\s\S]*?AS\s+\$\$/gi) || [];
  assert.equal(blocks.length, 2, 'expected exactly two function declarations');
  return blocks;
}

test('both functions are SECURITY DEFINER and STABLE', () => {
  // Scoped to the declaration blocks: "SECURITY DEFINER" also appears inside an
  // assertion's RAISE message, and counting raw occurrences would be wrong.
  for (const b of declBlocks()) {
    assert.match(b, /SECURITY\s+DEFINER/i);
    assert.match(b, /^\s*STABLE\s*$/m);
  }
});

test('both functions pin a fixed search_path', () => {
  const paths = CODE.match(/SET\s+search_path\s*=\s*pg_catalog,\s*public,\s*pg_temp/gi) || [];
  assert.equal(paths.length, 2,
    'a definer function without a fixed search_path can be hijacked by a shadowing schema');
});

test('both functions return TABLE(tenant_id uuid) and nothing more', () => {
  const rets = CODE.match(/RETURNS\s+TABLE\s*\(([^)]*)\)/gi) || [];
  assert.equal(rets.length, 2);
  for (const r of rets) {
    const cols = r.replace(/RETURNS\s+TABLE\s*\(/i, '').replace(/\)$/, '').split(',');
    assert.equal(cols.length, 1, 'exactly one returned column, got: ' + r);
    assert.match(cols[0].trim(), /^tenant_id\s+uuid$/i, 'the only column must be tenant_id uuid');
  }
});

test('both functions validate the limit: NULL, <1 and >1000 are rejected', () => {
  assert.equal((CODE.match(/p_limit IS NULL/g) || []).length, 2);
  assert.equal((CODE.match(/p_limit < 1/g) || []).length, 2);
  assert.equal((CODE.match(/p_limit > 1000/g) || []).length, 2);
  assert.equal((CODE.match(/invalid_limit/g) || []).length, 6, 'three guards per function');
});

test('both functions return DISTINCT tenant ids in a deterministic order', () => {
  assert.equal((CODE.match(/SELECT\s+DISTINCT\s+\w+\.tenant_id/gi) || []).length, 2);
  assert.equal((CODE.match(/ORDER\s+BY\s+\w+\.tenant_id/gi) || []).length, 2);
  assert.equal((CODE.match(/LIMIT\s+p_limit/gi) || []).length, 2);
});

test('both functions read schema-qualified source tables', () => {
  assert.match(CODE, /FROM\s+public\.channel_sync_queue_store/i);
  assert.match(CODE, /FROM\s+public\.scheduled_jobs/i);
});

test('the scheduler enum is schema-qualified', () => {
  assert.match(CODE, /'pending'::public\.scheduled_job_status/i);
});

// ---------------------------------------------------------------------------
// No payload, no dynamic SQL
// ---------------------------------------------------------------------------

test('no payload column is ever selected', () => {
  assert.ok(!/payload_json/i.test(CODE), 'the channel queue payload must never leave RLS');
  assert.ok(!/\bj\.payload\b/i.test(CODE), 'the scheduled-job payload must never leave RLS');
  assert.ok(!/SELECT\s+DISTINCT\s+\*/i.test(CODE));
  assert.ok(!/SELECT\s+\*/i.test(CODE), 'no whole-row select anywhere');
});

test('no forbidden column leaks through the return type', () => {
  // Guards against a future edit widening TABLE(...) to carry job detail.
  for (const forbidden of ['property_id', 'reservation_id', 'channel', 'action',
                           'job_type', 'last_error', 'retry_count uuid']) {
    assert.ok(!new RegExp('RETURNS\\s+TABLE[^)]*' + forbidden, 'i').test(CODE),
      'return type must not expose ' + forbidden);
  }
});

test('no dynamic SQL', () => {
  assert.ok(!/\bEXECUTE\s+format\s*\(/i.test(CODE));
  assert.ok(!/\bEXECUTE\s+'/i.test(CODE));
  assert.ok(!/\bEXECUTE\s+\w+\s*;/i.test(CODE), 'no EXECUTE of a variable');
  assert.ok(!/quote_ident\s*\(/i.test(CODE));
});

test('the only function argument is an integer row cap', () => {
  // Only the DECLARATIONS carry the parameter list; REVOKE/GRANT lines repeat
  // the signature and must not be counted as separate declarations.
  const decls = CODE.match(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+worker_resolvers\.\w+\s*\(([^)]*)\)/gi) || [];
  assert.equal(decls.length, 2, 'expected exactly two function declarations');
  for (const d of decls) {
    const args = d.slice(d.indexOf('(') + 1, d.lastIndexOf(')'));
    assert.match(args, /^\s*p_limit\s+integer\s*$/i,
      'exactly one integer argument — no caller-supplied identifier or predicate: ' + args);
  }
});

// ---------------------------------------------------------------------------
// Privilege outcome
// ---------------------------------------------------------------------------

test('PUBLIC execution is revoked on both functions', () => {
  for (const fn of FUNCS) {
    assert.ok(new RegExp('REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+worker_resolvers\\.' + fn +
      '\\(integer\\)\\s+FROM\\s+PUBLIC', 'i').test(CODE), 'REVOKE for ' + fn);
  }
  assert.match(CODE, /REVOKE\s+ALL\s+ON\s+SCHEMA\s+worker_resolvers\s+FROM\s+PUBLIC/i);
});

test('EXECUTE is granted only to the operator-supplied APP_ROLE, via quoted substitution', () => {
  for (const fn of FUNCS) {
    assert.ok(new RegExp('GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+worker_resolvers\\.' + fn +
      '\\(integer\\)\\s+TO\\s+:"APP_ROLE"', 'i').test(CODE), 'GRANT for ' + fn);
  }
  assert.match(CODE, /GRANT\s+USAGE\s+ON\s+SCHEMA\s+worker_resolvers\s+TO\s+:"APP_ROLE"/i);
  assert.ok(!/GRANT\s+CREATE\s+ON\s+SCHEMA\s+worker_resolvers\s+TO\s+:"APP_ROLE"/i.test(CODE),
    'the application role must never be able to create objects in this schema');
});

test('the function owner keeps USAGE but loses CREATE after installation', () => {
  assert.match(CODE, /GRANT\s+CREATE\s+ON\s+SCHEMA\s+worker_resolvers\s+TO\s+qyrvia_auth_resolver/i);
  assert.match(CODE, /REVOKE\s+CREATE\s+ON\s+SCHEMA\s+worker_resolvers\s+FROM\s+qyrvia_auth_resolver/i);
});

test('the runtime role receives no direct table privilege here', () => {
  assert.ok(!/GRANT\s+SELECT[^;]*channel_sync_queue_store/i.test(CODE),
    'column grants belong in migration 0085, not the bootstrap');
  assert.ok(!/GRANT\s+SELECT[^;]*scheduled_jobs/i.test(CODE));
});

// ---------------------------------------------------------------------------
// Prerequisites, transaction safety, secrets
// ---------------------------------------------------------------------------

test('requires a superuser session explicitly', () => {
  assert.match(CODE, /rolsuper\s+FROM\s+pg_roles\s+WHERE\s+rolname\s*=\s*current_user/i);
  assert.match(CODE, /must be run as a PostgreSQL superuser/i);
});

test('checks RLS and FORCE RLS on both source tables before doing anything', () => {
  assert.match(CODE, /relrowsecurity/i);
  assert.match(CODE, /relforcerowsecurity/i);
  assert.match(CODE, /channel_sync_queue_store/);
  assert.match(CODE, /scheduled_jobs/);
});

test('verifies the Phase 62 role attributes rather than assuming them', () => {
  assert.match(CODE, /rolcanlogin/i);
  assert.match(CODE, /rolbypassrls/i);
  assert.match(CODE, /rolsuper/i);
  assert.match(CODE, /Prerequisite not met: role qyrvia_auth_resolver does not exist/i);
  assert.match(CODE, /Prerequisite not met: role qyrvia_auth_schema_owner does not exist/i);
});

test('verifies every column it reads, rather than trusting a prior report', () => {
  for (const col of ['tenant_id', 'status', 'next_retry_at', 'next_run_at',
                     'retry_count', 'max_retries', 'run_at']) {
    assert.ok(new RegExp("column_name='" + col + "'").test(CODE),
      'missing existence check for ' + col);
  }
});

test('runs in one transaction with error-stop protection', () => {
  assert.match(SQL, /\\set ON_ERROR_STOP on/);
  assert.match(CODE, /^\s*BEGIN;\s*$/m);
  assert.match(CODE, /^\s*COMMIT;\s*$/m);
});

test('fails closed on drift instead of seizing or repairing', () => {
  assert.match(CODE, /Refusing to take ownership of an unexpected/i);
  assert.match(CODE, /unapproved function\(s\)/i);
  assert.match(CODE, /Nothing is dropped automatically/i);
});

test('asserts the full security contract at the end', () => {
  for (const probe of ['prosecdef', 'provolatile', 'proowner', 'nspowner',
                       'routine_privileges', 'has_schema_privilege']) {
    assert.ok(CODE.includes(probe), 'missing post-install assertion using ' + probe);
  }
});

test('contains no secret and no connection string', () => {
  assert.ok(!/postgres(ql)?:\/\/[^\s'"]*:[^\s'"@]+@/i.test(SQL), 'no credential-bearing URL');
  assert.ok(!/\bPASSWORD\s+'/i.test(SQL), 'no literal password');
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(SQL));
  assert.ok(!/\bDATABASE_URL\s*=\s*['"]/.test(SQL));
  // The usage example must use a placeholder, not a real URL.
  assert.match(SQL, /<CONNECTION_URL_WITH_SUPERUSER>/);
});

test('states that it must not run through the migration runner', () => {
  assert.match(SQL, /DO NOT RUN VIA THE MIGRATION RUNNER/i);
  // The ordering statement wraps across a comment line, so normalise first.
  const prose = SQL.replace(/\n--\s*/g, ' ').replace(/\s+/g, ' ');
  assert.match(prose, /BEFORE migration 0085/i, 'must state it runs before migration 0085');
  assert.match(prose, /must NEVER run this script/i,
    'must state the application runtime role never runs it');
});
