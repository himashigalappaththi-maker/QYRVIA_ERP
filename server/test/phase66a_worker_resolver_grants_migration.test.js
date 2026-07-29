'use strict';

/**
 * Phase 66A-B2F — static contract test for migration 0085, the companion
 * grant migration for the worker-resolver bootstrap.
 *
 * This test reads the SQL as TEXT and never executes it. That is deliberate:
 * this suite must never open a database connection, and a migration that
 * grants column access to a BYPASSRLS-holding role must have its exact
 * column list pinned so a careless edit cannot widen it quietly.
 *
 * No pg, no dotenv, no node:child_process, no PowerShell, no psql, no
 * server/.env — everything below is a regex or string match over the SQL
 * text of two committed files.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, '0085_worker_resolver_source_column_grants.sql');
const SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');

const MIGRATE_JS_PATH = path.join(__dirname, '..', 'src', 'db', 'migrate.js');
const MIGRATE_JS = fs.readFileSync(MIGRATE_JS_PATH, 'utf8');

/** Statement text with `--` comments stripped, so prose cannot satisfy an assertion. */
const CODE = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

/**
 * CODE, but with adjacent quoted-string-literal continuations collapsed —
 * SQL concatenates `'foo '\n'bar'` into the one runtime string "foo bar"
 * with NO character inserted at the boundary (any needed space already
 * lives inside one of the two literals), so this view is what the RAISE
 * EXCEPTION message text actually reads at runtime. Used only for
 * message-text assertions, never for structural/keyword assertions (those
 * stay on CODE).
 */
const PROSE = CODE.replace(/'\s*\n\s*'/g, '');

const QUEUE_TABLE = 'public.channel_sync_queue_store';
const JOBS_TABLE = 'public.scheduled_jobs';
const QUEUE_COLUMNS = ['tenant_id', 'status', 'next_retry_at', 'next_run_at', 'retry_count', 'max_retries'];
const JOBS_COLUMNS = ['tenant_id', 'status', 'run_at'];

function indexOfAll(str, re) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(str)) !== null) out.push(m.index);
  return out;
}

// ---------------------------------------------------------------------------
// File and numbering
// ---------------------------------------------------------------------------

test('migration 0085 exists at the expected path', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH));
  assert.ok(SQL.length > 2000, 'a migration this security-sensitive should not be a stub');
});

test('the file prefix is exactly 0085', () => {
  assert.equal(path.basename(MIGRATION_PATH).slice(0, 5), '0085_');
});

test('no other 0085 migration exists', () => {
  const matches = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^0085_/.test(f));
  assert.deepEqual(matches, ['0085_worker_resolver_source_column_grants.sql']);
});

test('0084 remains the immediate predecessor on disk', () => {
  const has0084 = fs.readdirSync(MIGRATIONS_DIR).some((f) => /^0084_/.test(f));
  assert.ok(has0084, '0085 must not be created ahead of a missing 0084');
});

// ---------------------------------------------------------------------------
// Transaction ownership
//
// This migration must NOT open or close its own transaction. Ownership
// belongs to server/src/db/migrate.js, which already wraps the migration SQL
// and the schema_migrations tracking insert in one atomic transaction (see
// the "Migration runner" section below). A transaction-control statement
// here would interact with the runner's own transaction on the same
// connection rather than create an independent one — see migration 0085's
// own header comment and Phase 66A-B2F-R1's report for the exact mechanism.
//
// A transaction-control BEGIN/COMMIT/ROLLBACK is distinguished from a
// plpgsql block delimiter by trailing punctuation: transaction control is
// `BEGIN;` / `COMMIT;` / `ROLLBACK;` alone on its own line (top-level SQL);
// a plpgsql block opens with bare `BEGIN` (no semicolon) after a DECLARE
// section, and closes with `END;` (not `COMMIT;`).
// ---------------------------------------------------------------------------

const TXN_BEGIN = /^BEGIN;\s*$/m;
const TXN_COMMIT = /^COMMIT;\s*$/m;
const TXN_ROLLBACK = /^ROLLBACK;\s*$/m;

test('contains zero top-level BEGIN statements', () => {
  assert.equal(indexOfAll(CODE, TXN_BEGIN).length, 0,
    'transaction ownership belongs to migrate.js, not this file');
});

test('contains zero top-level COMMIT statements', () => {
  assert.equal(indexOfAll(CODE, TXN_COMMIT).length, 0,
    'transaction ownership belongs to migrate.js, not this file');
});

test('contains zero top-level ROLLBACK statements', () => {
  assert.equal(indexOfAll(CODE, TXN_ROLLBACK).length, 0);
});

test('contains no SAVEPOINT or other transaction-control workaround', () => {
  assert.ok(!/\bSAVEPOINT\b/i.test(CODE));
  assert.ok(!/\bRELEASE\s+SAVEPOINT\b/i.test(CODE));
  assert.ok(!/\bSET\s+TRANSACTION\b/i.test(CODE));
  assert.ok(!/\bSTART\s+TRANSACTION\b/i.test(CODE));
});

test('the plpgsql DO blocks still delimit correctly with bare BEGIN and END;', () => {
  // Confirms the transaction-control removal did not also strip the (still
  // required) plpgsql block delimiters for the precondition/postcondition
  // DO $$ ... $$ blocks.
  const doBlocks = CODE.match(/\bDO\s*\$\$/gi) || [];
  const plpgsqlBegin = CODE.match(/^BEGIN\s*$/gm) || [];
  assert.equal(doBlocks.length, 2, 'expected exactly the precondition and postcondition DO blocks');
  assert.equal(plpgsqlBegin.length, 2, 'each DO block must still open with bare BEGIN (no semicolon)');
});

test('precondition checks precede the grants, which precede the postcondition checks', () => {
  const firstPrecondition = CODE.search(/phase66a_b2f (prerequisite not met|refuses)/i);
  const firstGrant = CODE.search(/\bGRANT\s+SELECT\b/i);
  const firstPostcondition = CODE.search(/phase66a_b2f postcondition failed/i);
  assert.ok(firstPrecondition >= 0 && firstGrant > firstPrecondition && firstPostcondition > firstGrant);
});

test('no exception handler suppresses a failure inside this file', () => {
  assert.ok(!/EXCEPTION\s+WHEN/i.test(CODE), 'a WHEN clause here could swallow a RAISE EXCEPTION');
});

test('every RAISE EXCEPTION is free to propagate out of the file to the runner', () => {
  // Nothing may catch or downgrade a RAISE EXCEPTION locally — every failure
  // must reach client.query(sql) in migrate.js as a rejected promise, which
  // is what triggers the runner's own ROLLBACK.
  const raises = CODE.match(/\bRAISE\s+EXCEPTION\b/gi) || [];
  assert.ok(raises.length >= 10, 'expected the full precondition + postcondition set of RAISE EXCEPTION calls');
  assert.ok(!/EXCEPTION\s+WHEN/i.test(CODE));
});

test('the only DROP is the standard ON COMMIT DROP idiom for a session-temporary table', () => {
  const dropMatches = CODE.match(/\bDROP\b/gi) || [];
  const onCommitDrop = CODE.match(/\bON\s+COMMIT\s+DROP\b/gi) || [];
  assert.equal(dropMatches.length, onCommitDrop.length,
    'every DROP token must be part of ON COMMIT DROP on a TEMP table; no persistent object may be dropped');
  assert.ok(/\bCREATE\s+TEMP\s+TABLE\b/i.test(CODE), 'ON COMMIT DROP requires a temp table in the same statement');
});

// ---------------------------------------------------------------------------
// Migration runner — statically prove migrate.js provides the atomicity this
// migration now depends on, so a future edit to the runner cannot silently
// break the guarantee this migration was corrected to rely on.
// ---------------------------------------------------------------------------

function fnBody(source, fnName) {
  const start = source.indexOf('async function ' + fnName);
  assert.ok(start >= 0, fnName + ' not found in migrate.js');
  // Bounded to the next top-level `async function` (or EOF) — not a full
  // parser, but sufficient to isolate one function body in this small file.
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/\nasync function /);
  return source.slice(start, nextFn === -1 ? source.length : start + 1 + nextFn);
}

const APPLY_MIGRATION = fnBody(MIGRATE_JS, 'applyMigration');

test('migrate.js applyMigration obtains exactly one client for the whole operation', () => {
  const connects = APPLY_MIGRATION.match(/\bpool\.connect\(\)/g) || [];
  assert.equal(connects.length, 1);
});

test('migrate.js applyMigration issues BEGIN before running the migration SQL', () => {
  const beginAt = APPLY_MIGRATION.search(/client\.query\(\s*['"]BEGIN['"]\s*\)/);
  const sqlAt = APPLY_MIGRATION.search(/client\.query\(\s*sql\s*\)/);
  assert.ok(beginAt >= 0, 'no client.query(\'BEGIN\') found');
  assert.ok(sqlAt >= 0, 'no client.query(sql) found');
  assert.ok(beginAt < sqlAt, 'BEGIN must precede the migration SQL');
});

test('migrate.js applyMigration inserts the schema_migrations tracking row after the migration SQL', () => {
  const sqlAt = APPLY_MIGRATION.search(/client\.query\(\s*sql\s*\)/);
  const insertAt = APPLY_MIGRATION.search(/INSERT\s+INTO\s+schema_migrations/i);
  assert.ok(insertAt >= 0, 'no schema_migrations INSERT found');
  assert.ok(sqlAt < insertAt, 'the tracking insert must run after the migration SQL, not before');
});

test('migrate.js applyMigration commits only after the tracking insert', () => {
  const insertAt = APPLY_MIGRATION.search(/INSERT\s+INTO\s+schema_migrations/i);
  const commitAt = APPLY_MIGRATION.search(/client\.query\(\s*['"]COMMIT['"]\s*\)/);
  assert.ok(commitAt >= 0, 'no client.query(\'COMMIT\') found');
  assert.ok(insertAt < commitAt, 'COMMIT must run after the tracking insert, proving the two are atomic together');
});

test('migrate.js applyMigration rolls back on the error path', () => {
  const catchAt = APPLY_MIGRATION.search(/}\s*catch\s*\(/);
  const rollbackAt = APPLY_MIGRATION.search(/client\.query\(\s*['"]ROLLBACK['"]\s*\)/);
  assert.ok(catchAt >= 0, 'no catch block found');
  assert.ok(rollbackAt >= 0, 'no client.query(\'ROLLBACK\') found');
  assert.ok(rollbackAt > catchAt, 'ROLLBACK must be issued from inside the catch block');
});

test('migrate.js applyMigration releases the same client in finally, unconditionally', () => {
  const finallyAt = APPLY_MIGRATION.search(/}\s*finally\s*{/);
  const releaseAt = APPLY_MIGRATION.search(/client\.release\(\)/);
  assert.ok(finallyAt >= 0, 'no finally block found');
  assert.ok(releaseAt >= 0, 'no client.release() found');
  assert.ok(releaseAt > finallyAt, 'client.release() must run from inside the finally block');
});

test('migrate.js applyMigration never commits before the schema_migrations insert', () => {
  // Every occurrence of a bare COMMIT call in this function must come after
  // every occurrence of the tracking insert — there is exactly one of each,
  // so this also catches a hypothetical second, earlier COMMIT.
  const commits = indexOfAll(APPLY_MIGRATION, /client\.query\(\s*['"]COMMIT['"]\s*\)/g);
  const inserts = indexOfAll(APPLY_MIGRATION, /INSERT\s+INTO\s+schema_migrations/gi);
  assert.equal(commits.length, 1);
  assert.equal(inserts.length, 1);
  assert.ok(commits[0] > inserts[0]);
});

// ---------------------------------------------------------------------------
// Role safety
// ---------------------------------------------------------------------------

test('creates no database role', () => {
  assert.ok(!/\bCREATE\s+ROLE\b/i.test(CODE));
});

test('alters no database role', () => {
  assert.ok(!/\bALTER\s+ROLE\b/i.test(CODE));
});

test('drops no database role', () => {
  assert.ok(!/\bDROP\s+ROLE\b/i.test(CODE));
});

test('grants no SUPERUSER attribute (no role-attribute statement exists at all)', () => {
  assert.ok(!/\b(ALTER|CREATE)\s+ROLE\b[^;]*SUPERUSER/i.test(CODE));
});

test('grants no BYPASSRLS attribute (no role-attribute statement exists at all)', () => {
  assert.ok(!/\b(ALTER|CREATE)\s+ROLE\b[^;]*BYPASSRLS/i.test(CODE));
});

test('grants no role membership', () => {
  // `GRANT <role> TO <role>` — membership. Distinguished from privilege grants,
  // which always name a privilege keyword immediately after GRANT.
  const membership = CODE.match(/\bGRANT\s+(?!ALL|EXECUTE|USAGE|CREATE|SELECT|INSERT|UPDATE|DELETE|REFERENCES|TRIGGER|TEMP|TEMPORARY|CONNECT)[a-z_"][\w"]*\s+TO\b/gi) || [];
  assert.deepEqual(membership, []);
});

test('contains no password operation', () => {
  assert.ok(!/\bPASSWORD\b/i.test(CODE));
});

test('exposes no SET ROLE or SET LOCAL ROLE to a runtime caller', () => {
  assert.ok(!/\bSET\s+(LOCAL\s+)?ROLE\b/i.test(CODE));
});

test('only qyrvia_auth_resolver appears as a GRANT target in this file', () => {
  const targets = CODE.match(/\bGRANT\s+SELECT\s*\([\s\S]*?\)\s*ON\s+TABLE\s+\S+\s+TO\s+([a-z_][\w]*)\s*;/gi) || [];
  assert.ok(targets.length === 2, 'expected exactly two column-level GRANT statements');
  for (const t of targets) {
    assert.match(t, /TO\s+qyrvia_auth_resolver\s*;$/i);
  }
});

test('never grants to PUBLIC, qyrvia_test or another runtime role', () => {
  assert.ok(!/\bGRANT\b[^;]*\bTO\s+PUBLIC\b/i.test(CODE));
  assert.ok(!/\bGRANT\b[^;]*\bTO\s+qyrvia_test\b/i.test(CODE));
});

// ---------------------------------------------------------------------------
// Exact queue grant
// ---------------------------------------------------------------------------

function extractGrant(table) {
  // [^)]* — a single GRANT's column list never contains a closing paren, so
  // this cannot cross into a *different* GRANT statement's own column list
  // the way a non-greedy [\s\S]*? spanning the whole file could.
  const re = new RegExp(
    'GRANT\\s+SELECT\\s*\\(([^)]*)\\)\\s*ON\\s+TABLE\\s+' + table.replace('.', '\\.') + '\\s+TO\\s+qyrvia_auth_resolver\\s*;',
    'i'
  );
  const m = CODE.match(re);
  return m ? m[1].split(',').map((c) => c.trim()).filter(Boolean) : null;
}

test('the queue grant targets exactly public.channel_sync_queue_store', () => {
  assert.ok(new RegExp('GRANT\\s+SELECT\\s*\\([\\s\\S]*?\\)\\s*ON\\s+TABLE\\s+' + QUEUE_TABLE.replace('.', '\\.') + '\\s+TO\\s+qyrvia_auth_resolver\\s*;', 'i').test(CODE));
});

test('the queue grant is column-level SELECT with the exact required columns, no missing, no extra', () => {
  const cols = extractGrant(QUEUE_TABLE);
  assert.ok(cols, 'queue grant not found');
  assert.deepEqual([...cols].sort(), [...QUEUE_COLUMNS].sort());
});

test('the queue grant is not table-wide SELECT', () => {
  assert.ok(!new RegExp('GRANT\\s+SELECT\\s+ON\\s+TABLE\\s+' + QUEUE_TABLE.replace('.', '\\.') + '\\s+TO', 'i').test(CODE),
    'a bare GRANT SELECT ON TABLE ... (no column list) would be table-wide');
});

// ---------------------------------------------------------------------------
// Exact jobs grant
// ---------------------------------------------------------------------------

test('the jobs grant targets exactly public.scheduled_jobs', () => {
  assert.ok(new RegExp('GRANT\\s+SELECT\\s*\\([\\s\\S]*?\\)\\s*ON\\s+TABLE\\s+' + JOBS_TABLE.replace('.', '\\.') + '\\s+TO\\s+qyrvia_auth_resolver\\s*;', 'i').test(CODE));
});

test('the jobs grant is column-level SELECT with the exact required columns, no missing, no extra', () => {
  const cols = extractGrant(JOBS_TABLE);
  assert.ok(cols, 'jobs grant not found');
  assert.deepEqual([...cols].sort(), [...JOBS_COLUMNS].sort());
});

test('the jobs grant is not table-wide SELECT', () => {
  assert.ok(!new RegExp('GRANT\\s+SELECT\\s+ON\\s+TABLE\\s+' + JOBS_TABLE.replace('.', '\\.') + '\\s+TO', 'i').test(CODE));
});

test('exactly two GRANT statements exist in the whole file', () => {
  const all = CODE.match(/\bGRANT\s+SELECT\b/gi) || [];
  assert.equal(all.length, 2);
});

// ---------------------------------------------------------------------------
// Prohibited operations
// ---------------------------------------------------------------------------

test('grants no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege', () => {
  for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    const re = new RegExp('\\bGRANT\\b[^;]*\\b' + priv + '\\b', 'i');
    assert.ok(!re.test(CODE), 'unexpected privilege granted: ' + priv);
  }
});

test('grants no ALL PRIVILEGES', () => {
  assert.ok(!/\bALL\s+PRIVILEGES\b/i.test(CODE));
  assert.ok(!/\bGRANT\s+ALL\b/i.test(CODE));
});

test('grants no EXECUTE and no USAGE (those belong to the bootstrap, not this migration)', () => {
  assert.ok(!/\bGRANT\s+EXECUTE\b/i.test(CODE));
  assert.ok(!/\bGRANT\s+USAGE\b/i.test(CODE));
});

test('grants no schema CREATE privilege', () => {
  assert.ok(!/\bGRANT\s+CREATE\b/i.test(CODE));
});

test('changes no table owner and no schema owner', () => {
  assert.ok(!/\bALTER\s+TABLE\b[^;]*\bOWNER\s+TO\b/i.test(CODE));
  assert.ok(!/\bALTER\s+SCHEMA\b[^;]*\bOWNER\s+TO\b/i.test(CODE));
});

test('disables no row-level security and removes no FORCE row-level security', () => {
  assert.ok(!/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(CODE));
  assert.ok(!/\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(CODE));
});

test('changes no RLS policy', () => {
  assert.ok(!/\b(CREATE|DROP|ALTER)\s+POLICY\b/i.test(CODE));
});

test('contains no CASCADE', () => {
  assert.ok(!/\bCASCADE\b/i.test(CODE));
});

test('references no table or schema other than the two authorized source tables and the temp snapshot', () => {
  const tableRefs = CODE.match(/\bON\s+TABLE\s+(\S+)/gi) || [];
  for (const ref of tableRefs) {
    const name = ref.replace(/^\s*ON\s+TABLE\s+/i, '').trim();
    assert.ok(name === QUEUE_TABLE || name === JOBS_TABLE, 'unexpected GRANT target table: ' + name);
  }
});

test('issues no migration-application command (no shell escape, no psql meta-command)', () => {
  assert.ok(!/\\i\b/.test(CODE));
  assert.ok(!/`/.test(CODE));
  assert.ok(!/\$\(/.test(CODE));
});

// ---------------------------------------------------------------------------
// Environment neutrality
// ---------------------------------------------------------------------------

test('contains no hostname, URL, connection string or environment-variable access', () => {
  assert.ok(!/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(CODE), 'no literal IP address');
  assert.ok(!/:\/\//.test(CODE), 'no URL-shaped literal');
  assert.ok(!/\bprocess\.env\b/i.test(CODE));
  assert.ok(!/\bgetenv\b/i.test(CODE));
  assert.ok(!/PGPASSWORD|PGHOST|PGPORT|PGDATABASE|PGUSER/i.test(CODE));
});

test('contains no psql connection invocation and no credential literal', () => {
  assert.ok(!/\bpsql\b/i.test(CODE));
  assert.ok(!/\\connect\b/i.test(CODE));
});

test('never hard-codes the qyrvia_test runtime role literal', () => {
  assert.ok(!/\bqyrvia_test\b/.test(CODE));
});

test('contains no reference to production or staging', () => {
  assert.ok(!/\bproduction\b/i.test(CODE));
  assert.ok(!/\bstaging\b/i.test(CODE));
});

// ---------------------------------------------------------------------------
// Assertion coverage — the migration's own DO blocks must actually check
// what section 5 of the phase specification requires, not merely claim to.
// ---------------------------------------------------------------------------

test('verifies the resolver role exists, is NOLOGIN, non-superuser and BYPASSRLS', () => {
  assert.match(PROSE, /prerequisite not met.*qyrvia_auth_resolver does not exist/is);
  assert.match(PROSE, /must be NOLOGIN/i);
  assert.match(PROSE, /must not be SUPERUSER/i);
  assert.match(PROSE, /must have BYPASSRLS/i);
});

test('verifies both source tables exist before granting', () => {
  assert.match(PROSE, new RegExp(QUEUE_TABLE.replace('.', '\\.') + ' does not exist', 'i'));
  assert.match(PROSE, new RegExp(JOBS_TABLE.replace('.', '\\.') + ' does not exist', 'i'));
});

test('verifies every required source column exists before granting', () => {
  assert.match(PROSE, /channel_sync_queue_store is missing a required column/i);
  assert.match(PROSE, /scheduled_jobs is missing a required column/i);
  for (const c of QUEUE_COLUMNS) assert.ok(CODE.includes(c), 'queue precondition should reference column ' + c);
  for (const c of JOBS_COLUMNS) assert.ok(CODE.includes(c), 'jobs precondition should reference column ' + c);
});

test('verifies RLS is enabled on both source tables before granting', () => {
  assert.match(PROSE, /RLS is disabled on public\.channel_sync_queue_store/i);
  assert.match(PROSE, /RLS is disabled on public\.scheduled_jobs/i);
});

test('verifies FORCE RLS is enabled on both source tables before granting', () => {
  assert.match(PROSE, /FORCE RLS is disabled on public\.channel_sync_queue_store/i);
  assert.match(PROSE, /FORCE RLS is disabled on public\.scheduled_jobs/i);
});

test('postcondition verifies no table-level SELECT ACL exists for the resolver role', () => {
  assert.match(PROSE, /table-wide SELECT ACL exists/i);
});

test('postcondition verifies the exact column-level grant set on both tables', () => {
  assert.match(PROSE, /unexpected column-level SELECT.*channel_sync_queue_store/is);
  assert.match(PROSE, /unexpected column-level SELECT.*scheduled_jobs/is);
});

test('postcondition verifies no non-SELECT privilege exists for the resolver role', () => {
  assert.match(PROSE, /non-SELECT table-level privilege/i);
  assert.match(PROSE, /non-SELECT column-level privilege/i);
});

test('postcondition verifies PUBLIC received nothing', () => {
  assert.match(PROSE, /PUBLIC holds a table-level privilege/i);
  assert.match(PROSE, /PUBLIC holds a column-level privilege/i);
});

test('postcondition verifies table ownership is unchanged, using a pre-grant snapshot', () => {
  assert.match(CODE, /CREATE\s+TEMP\s+TABLE\s+phase66a_b2f_owner_snapshot/i);
  assert.match(CODE, /owner_before/i);
  assert.match(PROSE, /a source table owner changed/i);
});

test('postcondition re-verifies RLS and FORCE RLS remain enabled after granting', () => {
  assert.match(PROSE, /RLS or FORCE RLS is no longer enabled/i);
});

test('postcondition re-verifies the resolver role attributes are unchanged', () => {
  assert.match(PROSE, /qyrvia_auth_resolver role attributes changed/i);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('the ownership snapshot is a session-temporary table that never persists', () => {
  assert.match(CODE, /CREATE\s+TEMP\s+TABLE\s+phase66a_b2f_owner_snapshot[\s\S]*?ON\s+COMMIT\s+DROP/i);
});

test('creates no permanent object of any kind', () => {
  assert.ok(!/\bCREATE\s+(TABLE|SCHEMA|FUNCTION|VIEW|INDEX|SEQUENCE|TYPE|TRIGGER)\b/i.test(CODE),
    'only a TEMP TABLE may be created, and that is checked separately');
});
