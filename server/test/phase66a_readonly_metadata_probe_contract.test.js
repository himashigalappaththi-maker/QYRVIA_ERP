'use strict';

/**
 * Phase 66A-B2A — STATIC CONTRACT for the guarded read-only metadata probe.
 *
 * This suite reads server/scripts/db/phase66a_readonly_metadata_probe.js as
 * TEXT and asserts its security properties. It never executes the probe, never
 * loads `pg`, never opens a connection and never mocks one.
 *
 * Two views of the file are used deliberately:
 *
 *   SRC   the raw text — for header/prose assertions
 *   CODE  the same file with comments stripped — for every SECURITY assertion,
 *         so that a reassuring sentence in a comment can never satisfy a
 *         requirement that the executable code does not actually meet.
 *
 * SQL keyword scans are case-SENSITIVE against upper case on purpose: the probe
 * legitimately contains lower-case identifiers such as `resolver_table_grants`
 * and the privilege literal 'CREATE', and those must not be mistaken for a
 * GRANT statement or DDL.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');
const PROBE_PATH = path.join(SERVER_DIR, 'scripts', 'db', 'phase66a_readonly_metadata_probe.js');

const SRC = fs.readFileSync(PROBE_PATH, 'utf8');

/** Strip block and line comments so security assertions see executable code only. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}
const CODE = stripComments(SRC);

/** The SQL constants, isolated from the surrounding JavaScript. */
function sqlLiterals() {
  const out = [];
  const re = /const\s+(SQL_[A-Z_]+)\s*=\s*(`[\s\S]*?`|'[^']*')/g;
  let m;
  while ((m = re.exec(CODE)) !== null) out.push({ name: m[1], body: m[2] });
  return out;
}

// ---------------------------------------------------------------------------
// File identity
// ---------------------------------------------------------------------------

test('the probe exists at the exact approved path', () => {
  assert.ok(fs.existsSync(PROBE_PATH), 'server/scripts/db/phase66a_readonly_metadata_probe.js must exist');
  assert.ok(fs.statSync(PROBE_PATH).isFile());
});

test('the probe is a strict-mode CommonJS script', () => {
  assert.match(SRC, /^'use strict';/, 'must open with the strict directive');
});

// ---------------------------------------------------------------------------
// Connection input — TEST_DATABASE_URL only
// ---------------------------------------------------------------------------

test('does not load dotenv', () => {
  assert.ok(!/dotenv/i.test(SRC), 'dotenv must never appear, not even in a comment');
});

test('does not reference server/.env', () => {
  // `process.env` is fine; an .env FILE path is not. Match only file-shaped uses.
  assert.ok(!/server[\/\\]\.env/.test(SRC), 'the probe must never point at server/.env');
  assert.ok(!/['"`][^'"`]*\.env['"`]/.test(SRC), 'no .env file path may appear as a literal');
  assert.ok(!/readFileSync[^\n]*\.env/.test(SRC), 'no .env file may be read');
});

test('never references DATABASE_URL other than TEST_DATABASE_URL', () => {
  assert.ok(!/(?<!TEST_)DATABASE_URL/.test(CODE),
    'only TEST_DATABASE_URL may be referenced; bare DATABASE_URL is forbidden');
});

test('reads TEST_DATABASE_URL from the process environment', () => {
  assert.match(CODE, /process\.env\.TEST_DATABASE_URL/,
    'the target must come from process.env.TEST_DATABASE_URL');
});

test('reads exactly one environment variable', () => {
  const names = new Set((CODE.match(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g) || [])
    .map((s) => s.replace('process.env.', '')));
  assert.deepEqual([...names].sort(), ['TEST_DATABASE_URL']);
});

test('never enumerates process.env', () => {
  assert.ok(!/Object\.(keys|values|entries)\s*\(\s*process\.env/.test(CODE));
  assert.ok(!/JSON\.stringify\s*\(\s*process\.env/.test(CODE));
  assert.ok(!/\.\.\.process\.env/.test(CODE));
});

test('provides no fallback URL and embeds no connection string', () => {
  assert.ok(!/postgres(ql)?:\/\/[^\s'"`]+/.test(CODE),
    'no literal connection URL may appear anywhere in executable code');
  assert.ok(!/process\.env\.TEST_DATABASE_URL\s*\|\|/.test(CODE),
    'a `||` fallback after the env read would defeat the guard');
});

test('fails with the fixed identifier when TEST_DATABASE_URL is missing', () => {
  assert.match(CODE, /'TEST_DATABASE_URL_REQUIRED'/);
});

// ---------------------------------------------------------------------------
// Pre-connection target guard
// ---------------------------------------------------------------------------

test('parses the URL with the standard parser before requiring pg', () => {
  const urlAt = CODE.indexOf('new URL(');
  const pgAt  = CODE.indexOf("require('pg')");
  assert.ok(urlAt > -1, 'must use the standard URL parser');
  assert.ok(pgAt  > -1, 'must require pg somewhere');
  assert.ok(urlAt < pgAt, 'URL parsing must happen before the driver is loaded');
});

test('requires pg exactly once, and only after the target guard has run', () => {
  const occurrences = (CODE.match(/require\('pg'\)/g) || []).length;
  assert.equal(occurrences, 1, 'pg must be required exactly once');
  assert.ok(CODE.indexOf('resolveTarget') < CODE.indexOf("require('pg')"),
    'the guard function must be defined and invoked ahead of the driver import');
  assert.ok(!/^\s*const .*require\('pg'\)/m.test(CODE.split('async function main')[0] || ''),
    'pg must not be required at module top level');
});

test('the guard demands a PostgreSQL scheme', () => {
  assert.match(CODE, /url\.protocol\s*!==\s*'postgres:'/);
  assert.match(CODE, /url\.protocol\s*!==\s*'postgresql:'/);
});

test('the host guard requires the literal loopback address', () => {
  assert.match(CODE, /const ALLOWED_HOST\s*=\s*'127\.0\.0\.1'/);
  assert.match(CODE, /hostname\s*!==\s*ALLOWED_HOST/,
    'the host must be compared against the literal 127.0.0.1');
  assert.match(CODE, /'DATABASE_HOST_NOT_ALLOWED'/);
});

test('localhost and ::1 are rejected — never accepted as equivalents', () => {
  assert.ok(!/hostname\s*===\s*'localhost'/.test(CODE),
    'localhost must not be treated as an accepted host');
  assert.ok(!/'localhost'/.test(CODE),
    'no acceptance branch may reference localhost in executable code');
  assert.ok(!/'::1'/.test(CODE),
    'the IPv6 loopback must not be accepted');
});

test('the port guard requires exactly 5432 and rejects an absent port', () => {
  assert.match(CODE, /const ALLOWED_PORT\s*=\s*5432/);
  assert.match(CODE, /url\.port\s*!==\s*String\(ALLOWED_PORT\)/,
    'an absent port must fail rather than silently default');
  assert.match(CODE, /'DATABASE_PORT_NOT_ALLOWED'/);
});

test('the database guard requires exactly /qyrvia_test', () => {
  assert.match(CODE, /const ALLOWED_DB\s*=\s*'qyrvia_test'/);
  assert.match(CODE, /url\.pathname\s*!==\s*'\/'\s*\+\s*ALLOWED_DB/);
  assert.match(CODE, /'DATABASE_NAME_NOT_ALLOWED'/);
});

test('every connection option and URL fragment is rejected', () => {
  assert.match(CODE, /url\.hash/,        'a fragment must be rejected');
  assert.match(CODE, /url\.search/,      'a query string must be rejected');
  assert.match(CODE, /searchParams/,     'parsed parameters must be rejected');
  assert.match(CODE, /'DATABASE_OPTIONS_NOT_ALLOWED'/);
});

test('multi-host lists cannot pass the host guard', () => {
  assert.match(CODE, /hostname\.indexOf\(','\)/,
    'a comma-separated multi-host target must be refused explicitly');
});

test('the guard completes before any Pool is constructed', () => {
  assert.ok(CODE.indexOf('resolveTarget()') < CODE.indexOf('new Pool('),
    'the target must be resolved before the pool exists');
});

test('all five fixed target-guard error codes are present', () => {
  for (const code of ['TEST_DATABASE_URL_INVALID', 'DATABASE_HOST_NOT_ALLOWED',
                      'DATABASE_PORT_NOT_ALLOWED', 'DATABASE_NAME_NOT_ALLOWED',
                      'DATABASE_OPTIONS_NOT_ALLOWED']) {
    assert.ok(CODE.includes("'" + code + "'"), 'missing fixed error code ' + code);
  }
});

// ---------------------------------------------------------------------------
// Read-only enforcement
// ---------------------------------------------------------------------------

test('opens an explicit READ ONLY transaction', () => {
  assert.match(CODE, /const SQL_BEGIN_READ_ONLY\s*=\s*'BEGIN READ ONLY'/);
});

test('verifies transaction_read_only is on before trusting the session', () => {
  assert.match(CODE, /SHOW transaction_read_only/);
  assert.match(CODE, /transaction_read_only\s*!==\s*'on'/,
    'the probe must assert the server reports read-only, not merely request it');
  assert.match(CODE, /'READ_ONLY_TRANSACTION_REQUIRED'/);
});

test('the read-only transaction is opened before any metadata query', () => {
  const begin = CODE.indexOf('SQL_BEGIN_READ_ONLY');
  const show  = CODE.indexOf('SQL_SHOW_READ_ONLY');
  const meta  = CODE.indexOf('SQL_EXPECTED_ROLES');
  // Guard on the ORDER OF USE inside main(), not the constant declarations.
  const main  = CODE.slice(CODE.indexOf('async function main'));
  assert.ok(begin > -1 && show > -1 && meta > -1);
  assert.ok(main.indexOf('SQL_BEGIN_READ_ONLY') < main.indexOf('SQL_IDENTITY'),
    'BEGIN READ ONLY must be issued before the identity query');
  assert.ok(main.indexOf('SQL_SHOW_READ_ONLY') < main.indexOf('SQL_IDENTITY'),
    'read-only must be verified before the identity query');
  assert.ok(main.indexOf('SQL_SHOW_READ_ONLY') < main.indexOf('collect('),
    'read-only must be verified before catalog collection');
});

// ---------------------------------------------------------------------------
// Post-connection identity guard
// ---------------------------------------------------------------------------

test('verifies the connected database, host and port from the server itself', () => {
  assert.match(CODE, /current_database\(\)/);
  assert.match(CODE, /inet_server_addr\(\)/);
  assert.match(CODE, /inet_server_port\(\)/);
  assert.match(CODE, /database_name\s*!==\s*ALLOWED_DB/);
  assert.match(CODE, /server_host\s*!==\s*ALLOWED_HOST/);
  assert.match(CODE, /Number\(identity\.server_port\)\s*!==\s*ALLOWED_PORT/);
});

test('all three fixed post-connection error codes are present', () => {
  for (const code of ['CONNECTED_DATABASE_NOT_ALLOWED', 'CONNECTED_HOST_NOT_ALLOWED',
                      'CONNECTED_PORT_NOT_ALLOWED']) {
    assert.ok(CODE.includes("'" + code + "'"), 'missing fixed error code ' + code);
  }
});

test('acquires exactly one client from a single-connection pool', () => {
  assert.equal((CODE.match(/new Pool\(/g) || []).length, 1);
  assert.equal((CODE.match(/pool\.connect\(/g) || []).length, 1);
  assert.match(CODE, /max:\s*1/);
});

// ---------------------------------------------------------------------------
// Loopback normalisation (Phase 66A-B2B-C5)
//
// Casting `inet` to text preserves the network mask, so a loopback server
// renders as 127.0.0.1/32 and can never equal the bare literal 127.0.0.1. The
// probe therefore normalises with host() before comparing. These tests pin the
// normalisation in place AND pin the policy that it must not widen: exactly one
// host is permitted, and everything else is still refused.
// ---------------------------------------------------------------------------

/** The permitted-host predicate exactly as written at the probe's host guard:
 *  `identity.server_host !== ALLOWED_HOST` -> throw. Mirrored here so the
 *  accept/reject behaviour can be exercised without a database. */
const hostRejected = (value) => value !== '127.0.0.1';

test('the identity query normalises the server address with host()', () => {
  const sql = sqlLiterals().find((l) => l.name === 'SQL_IDENTITY');
  assert.ok(sql, 'SQL_IDENTITY must exist');
  assert.ok(
    sql.body.includes('pg_catalog.host(pg_catalog.inet_server_addr()) AS server_host'),
    'server_host must be selected through host() so the /32 mask is stripped');
});

test('the masked inet text form is no longer selected anywhere', () => {
  assert.ok(!/inet_server_addr\(\)::text/.test(CODE),
    'casting inet straight to text reintroduces the mask and breaks the guard');
  assert.equal(
    (CODE.match(/pg_catalog\.host\(pg_catalog\.inet_server_addr\(\)\) AS server_host/g) || []).length,
    1, 'the normalised expression must appear exactly once');
});

test('the permitted host is still exactly the IPv4 loopback literal', () => {
  assert.match(CODE, /const ALLOWED_HOST = '127\.0\.0\.1';/,
    'the allowlist must remain a single literal address');
  const literals = new Set(CODE.match(/const ALLOWED_HOST = '[^']*'/g) || []);
  assert.equal(literals.size, 1, 'only one ALLOWED_HOST definition may exist');
});

test('the host comparison is still strict inequality against ALLOWED_HOST', () => {
  assert.match(CODE, /identity\.server_host !== ALLOWED_HOST/,
    'the guard must remain an exact value comparison');
});

test('a rejected host still raises CONNECTED_HOST_NOT_ALLOWED', () => {
  assert.match(CODE, /CONN_HOST:\s*'CONNECTED_HOST_NOT_ALLOWED'/);
  const guard = CODE.slice(CODE.indexOf('identity.server_host !== ALLOWED_HOST'));
  assert.match(guard.slice(0, 160), /ProbeError\(CAT\.CONNECT, ERR\.CONN_HOST, null\)/,
    'the failure code must be unchanged');
});

test('the correction introduces no host-matching loophole', () => {
  const guardArea = CODE.slice(CODE.indexOf('async function main'));
  for (const loophole of ['startsWith', '.includes(', 'substring', 'indexOf(ALLOWED_HOST',
                          'split(\'/\')', 'replace(']) {
    assert.ok(!guardArea.includes(loophole),
      'host acceptance must not be loosened with ' + loophole);
  }
  assert.ok(!/'localhost'/.test(CODE), 'localhost must not become acceptable');
  assert.ok(!/'::1'/.test(CODE), 'the IPv6 loopback must not become acceptable');
  assert.ok(!/\/(8|16|24|32)\b/.test(CODE.replace(/pg_catalog/g, '')),
    'no CIDR or mask literal may enter the acceptance path');
});

test('a normalised IPv4 loopback address is accepted by the host guard', () => {
  assert.equal(hostRejected('127.0.0.1'), false,
    'the value host() returns for a loopback server must pass');
});

test('the masked form would still be rejected — proving normalisation is required', () => {
  assert.equal(hostRejected('127.0.0.1/32'), true,
    'the guard is exact-match, so the mask must be stripped before comparison');
});

test('non-loopback addresses remain rejected', () => {
  for (const addr of ['10.0.0.5', '192.168.1.10', '172.16.0.1', '8.8.8.8',
                      '127.0.0.2', '0.0.0.0']) {
    assert.equal(hostRejected(addr), true, addr + ' must not be accepted');
  }
});

test('NULL, empty and non-IPv4 loopback forms remain rejected', () => {
  for (const v of [null, undefined, '', '::1', 'localhost', '127.0.0.1 ']) {
    assert.equal(hostRejected(v), true, String(v) + ' must not be accepted');
  }
});

test('the database and port assertions are untouched by the correction', () => {
  assert.match(CODE, /identity\.database_name !== ALLOWED_DB/);
  assert.match(CODE, /ProbeError\(CAT\.CONNECT, ERR\.CONN_DB, null\)/);
  assert.match(CODE, /Number\(identity\.server_port\) !== ALLOWED_PORT/);
  assert.match(CODE, /ProbeError\(CAT\.CONNECT, ERR\.CONN_PORT, null\)/);
  const sql = sqlLiterals().find((l) => l.name === 'SQL_IDENTITY');
  assert.ok(sql.body.includes('current_database()          AS database_name'));
  assert.ok(sql.body.includes('inet_server_port()          AS server_port'));
});

test('read-only enforcement is untouched by the correction', () => {
  assert.match(CODE, /const SQL_BEGIN_READ_ONLY = 'BEGIN READ ONLY'/);
  assert.match(CODE, /const SQL_ROLLBACK        = 'ROLLBACK'/);
  assert.match(CODE, /transaction_read_only\s*!==\s*'on'/);
  assert.match(CODE, /'READ_ONLY_TRANSACTION_REQUIRED'/);
  const main = CODE.slice(CODE.indexOf('async function main'));
  assert.ok(main.indexOf('SQL_SHOW_READ_ONLY') < main.indexOf('SQL_IDENTITY'),
    'read-only must still be verified before the identity query');
});

// ---------------------------------------------------------------------------
// SQL surface
// ---------------------------------------------------------------------------

test('every SQL statement is a static literal with no interpolation', () => {
  assert.ok(!/\$\{/.test(CODE), 'template interpolation must not appear anywhere');
  const lits = sqlLiterals();
  assert.ok(lits.length >= 10, 'expected the SQL to live in named constants');
  for (const { name, body } of lits) {
    assert.ok(!body.includes('${'), name + ' must not interpolate');
    assert.ok(!body.includes("' +"), name + ' must not concatenate');
  }
});

test('no SQL is built by concatenation or supplied by a caller', () => {
  assert.ok(!/query\(\s*['"`][^'"`]*['"`]\s*\+/.test(CODE), 'no concatenated query text');
  assert.ok(!/query\(\s*sql\s*\)/.test(CODE), 'no caller-supplied SQL variable');
});

test('only allowlisted catalogs and views are read', () => {
  const ALLOWED = new Set([
    'pg_catalog.pg_roles',
    'pg_catalog.pg_auth_members',
    'pg_catalog.pg_namespace',
    'pg_catalog.pg_proc',
    'pg_catalog.pg_class',
    'pg_catalog.pg_attribute',
    'pg_catalog.pg_type',
    'pg_catalog.pg_enum',
    'information_schema.table_privileges',
    'information_schema.column_privileges',
    'information_schema.routine_privileges',
  ]);
  const sql = sqlLiterals().map((l) => l.body).join('\n');
  const refs = (sql.match(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)/g) || [])
    .map((s) => s.replace(/^(FROM|JOIN)\s+/, ''));
  assert.ok(refs.length > 0, 'expected relation references to inspect');
  for (const r of refs) {
    assert.ok(ALLOWED.has(r), 'non-allowlisted relation referenced: ' + r);
  }
});

test('only allowlisted metadata functions are called', () => {
  const sql = sqlLiterals().map((l) => l.body).join('\n');
  for (const fn of ['current_database()', 'current_user', 'session_user',
                    'inet_server_addr()', 'inet_server_port()']) {
    assert.ok(sql.includes(fn), 'expected allowlisted primitive ' + fn);
  }
  assert.ok(/has_schema_privilege\(/.test(sql));
  assert.ok(/has_function_privilege\(/.test(sql));
  assert.ok(/has_table_privilege\(/.test(sql));
});

test('never queries schema_migrations', () => {
  assert.ok(!/schema_migrations/.test(SRC),
    'the migration ledger is an application table and is out of scope');
});

test('never reads a business row from any application table', () => {
  const sql = sqlLiterals().map((l) => l.body).join('\n');
  for (const t of ['reservations', 'guests', 'payments', 'folios', 'invoices',
                   'webhook', 'ota_', 'credential', 'audit']) {
    assert.ok(!new RegExp('\\b(FROM|JOIN)\\s+[a-z_.]*' + t, 'i').test(sql),
      'business table referenced: ' + t);
  }
  assert.ok(!/\b(FROM|JOIN)\s+(public\.)?channel_sync_queue_store\b/.test(sql),
    'queue rows must never be selected — only catalog metadata about the table');
  assert.ok(!/\b(FROM|JOIN)\s+(public\.)?scheduled_jobs\b/.test(sql),
    'job rows must never be selected — only catalog metadata about the table');
});

test('never touches a payload column', () => {
  assert.ok(!/payload/i.test(SRC), 'payload and payload_json are entirely out of scope');
});

test('never selects a wildcard column list', () => {
  assert.ok(!/SELECT\s+\*/i.test(CODE), 'SELECT * is forbidden; count(*) is not a wildcard select');
});

test('contains no write SQL', () => {
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'COPY', 'UPSERT']) {
    assert.ok(!new RegExp('\\b' + kw + '\\s').test(CODE), 'write keyword present: ' + kw);
  }
});

test('contains no DDL', () => {
  assert.ok(!/\b(CREATE|ALTER|DROP)\s+(TABLE|SCHEMA|FUNCTION|ROLE|INDEX|VIEW|TYPE|DATABASE|POLICY|SEQUENCE)\b/.test(CODE),
    'no DDL statement may appear');
});

test('contains no GRANT or REVOKE statement', () => {
  assert.ok(!/\bGRANT\s+/.test(CODE), 'GRANT is forbidden (lower-case *_grants aliases are fine)');
  assert.ok(!/\bREVOKE\s+/.test(CODE), 'REVOKE is forbidden');
});

test('never changes the session role', () => {
  assert.ok(!/\b(SET|RESET)\s+ROLE\b/.test(CODE));
});

test('takes no locks and subscribes to no channel', () => {
  assert.ok(!/FOR\s+UPDATE/i.test(CODE));
  assert.ok(!/FOR\s+SHARE/i.test(CODE));
  assert.ok(!/pg_advisory/i.test(CODE));
  assert.ok(!/\bLISTEN\b/.test(CODE));
  assert.ok(!/\bNOTIFY\b/.test(CODE));
});

test('never reads a function body', () => {
  assert.ok(!/pg_get_functiondef/i.test(SRC),
    'function source must not be extracted; attributes are sufficient');
});

test('the only multi-word transaction statements are BEGIN READ ONLY and ROLLBACK', () => {
  assert.match(CODE, /'BEGIN READ ONLY'/);
  assert.match(CODE, /'ROLLBACK'/);
  assert.ok(!/'COMMIT'/.test(CODE), 'a read-only probe must never commit');
  assert.ok(!/BEGIN;\s*[A-Z]/.test(CODE), 'no statement batching');
});

// ---------------------------------------------------------------------------
// Forbidden implementation constructs
// ---------------------------------------------------------------------------

test('spawns no process and evaluates no code', () => {
  for (const bad of ['child_process', 'execSync', 'spawnSync', 'new Function',
                     'node:vm', "require('vm')", 'powershell', 'cmd.exe', 'shell: true']) {
    assert.ok(!SRC.toLowerCase().includes(bad.toLowerCase()), 'forbidden construct: ' + bad);
  }
  assert.ok(!/\beval\s*\(/.test(CODE));
  assert.ok(!/\bspawn\s*\(/.test(CODE));
  assert.ok(!/\bexec\s*\(/.test(CODE));
  assert.ok(!/\bfork\s*\(/.test(CODE));
  assert.ok(!/\bimport\s*\(/.test(CODE), 'dynamic import is forbidden');
});

test('uses no network library other than the PostgreSQL driver', () => {
  assert.ok(!/require\('node:https?'\)/.test(CODE));
  assert.ok(!/\bfetch\s*\(/.test(CODE));
  assert.ok(!/axios/i.test(SRC));
  assert.ok(!/\bcurl\b/i.test(SRC));
  const requires = (CODE.match(/require\('([^']+)'\)/g) || []).map((s) => s.slice(9, -2));
  assert.deepEqual([...new Set(requires)].sort(), ['pg'],
    'pg must be the only runtime dependency the probe loads');
});

test('performs no filesystem mutation and loads no fs module', () => {
  for (const bad of ['writeFile', 'appendFile', 'unlink', 'rmSync', 'rmdir',
                     'renameSync', 'copyFile', 'mkdir', 'chmod']) {
    assert.ok(!CODE.includes(bad), 'filesystem mutation present: ' + bad);
  }
  assert.ok(!/require\('(node:)?fs'\)/.test(CODE), 'the probe needs no filesystem access at all');
});

// ---------------------------------------------------------------------------
// Cleanup and transaction safety
// ---------------------------------------------------------------------------

test('uses structured try/catch/finally', () => {
  assert.match(CODE, /\btry\s*\{/);
  assert.match(CODE, /\bcatch\s*\(/);
  assert.match(CODE, /\bfinally\s*\{/);
});

test('rolls back, releases the client and ends the pool inside finally', () => {
  const finallyBlock = CODE.slice(CODE.indexOf('} finally {'));
  assert.ok(finallyBlock.includes('SQL_ROLLBACK'), 'ROLLBACK must run in finally');
  assert.ok(finallyBlock.includes('client.release()'), 'the client must be released in finally');
  assert.ok(finallyBlock.includes('pool.end()'), 'the pool must be ended in finally');
});

test('rollback is attempted only when a transaction was actually opened', () => {
  assert.match(CODE, /txOpen\s*=\s*true/);
  assert.match(CODE, /if\s*\(\s*txOpen\s*\)/);
});

test('cleanup failures are classified, never rethrown as raw errors', () => {
  assert.match(CODE, /'PROBE_CLEANUP_ERROR'/);
  const finallyBlock = CODE.slice(CODE.indexOf('} finally {'));
  assert.ok(!/throw/.test(finallyBlock), 'cleanup must not mask the original failure');
});

test('never retries and never opens a second connection', () => {
  assert.equal((CODE.match(/pool\.connect\(/g) || []).length, 1);
  assert.ok(!/retry|attempt\s*<|while\s*\(/i.test(CODE), 'no retry loop may exist');
});

// ---------------------------------------------------------------------------
// Output and error redaction
// ---------------------------------------------------------------------------

test('the only stdout write is a single sanitized JSON document', () => {
  const logs = CODE.match(/console\.log\([^\n]*\)/g) || [];
  assert.equal(logs.length, 1, 'exactly one stdout write is permitted');
  assert.match(logs[0], /console\.log\(JSON\.stringify\(result\)\)/);
});

test('never prints a raw driver message or a stack trace', () => {
  assert.ok(!/\.message\b/.test(CODE), 'error.message must never be read');
  assert.ok(!/\.stack\b/.test(CODE), 'stack traces must never be emitted');
  assert.ok(!/JSON\.stringify\(\s*(e|err|error)\s*\)/.test(CODE), 'errors must not be serialized');
});

test('only a validated SQLSTATE may accompany an error category', () => {
  assert.match(CODE, /function safePgCode/);
  assert.match(CODE, /\/\^\[0-9A-Z\]\{5\}\$\//, 'SQLSTATE must be shape-checked before it is emitted');
});

test('all six fixed stderr categories exist', () => {
  for (const c of ['PROBE_CONFIGURATION_ERROR', 'PROBE_CONNECTION_ERROR',
                   'PROBE_READ_ONLY_ERROR', 'PROBE_METADATA_ERROR',
                   'PROBE_CLEANUP_ERROR', 'PROBE_STATE_INVALID']) {
    assert.ok(CODE.includes("'" + c + "'"), 'missing stderr category ' + c);
  }
});

test('never emits the connection URL or any environment value', () => {
  assert.ok(!/console\.(log|error)\([^)]*connectionString/.test(CODE));
  assert.ok(!/console\.(log|error)\([^)]*process\.env/.test(CODE));
  assert.ok(!/stderr\.write\([^)]*process\.env/.test(CODE));
  assert.ok(!/stderr\.write\([^)]*connectionString/.test(CODE));
});

test('password presence is evaluated but never stored or reported', () => {
  assert.match(CODE, /void \(url\.password\.length > 0\)/,
    'password presence must be discarded immediately');
  assert.ok(!/password_present|has_password|passwordPresent/.test(CODE),
    'password presence must not reach the output object');
});

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

test('the success document carries exactly the ten approved top-level keys', () => {
  const collect = CODE.slice(CODE.indexOf('async function collect'), CODE.indexOf('function evaluate'));
  for (const key of ['probe_version', 'target', 'connected_identity', 'expected_roles',
                     'role_memberships', 'source_tables', 'worker_resolvers',
                     'auth_resolvers', 'privilege_summary', 'verdict']) {
    assert.ok(new RegExp('^\\s*' + key + ':', 'm').test(collect), 'missing output key ' + key);
  }
});

test('the reported target is fixed, not echoed from the parsed URL', () => {
  const collect = CODE.slice(CODE.indexOf('async function collect'), CODE.indexOf('function evaluate'));
  assert.match(collect, /host:\s*ALLOWED_HOST/);
  assert.match(collect, /port:\s*ALLOWED_PORT/);
  assert.match(collect, /database:\s*ALLOWED_DB/);
});

test('the verdict is one of exactly two fixed values', () => {
  assert.match(CODE, /'PRE_BOOTSTRAP_STATE_VALID'/);
  assert.match(CODE, /'PRE_BOOTSTRAP_STATE_INVALID'/);
  const verdicts = new Set((CODE.match(/'PRE_BOOTSTRAP_STATE_[A-Z]+'/g) || []));
  assert.equal(verdicts.size, 2, 'no third verdict value may exist');
});

// ---------------------------------------------------------------------------
// Pre-bootstrap state contract
// ---------------------------------------------------------------------------

test('a valid verdict requires worker_resolvers to be absent', () => {
  const ev = CODE.slice(CODE.indexOf('function evaluate'));
  assert.match(ev, /wr\.exists\s*===\s*false/, 'the schema must not already exist');
  assert.match(ev, /wr\.function_count\s*===\s*0/, 'no resolver function may already exist');
});

test('a valid verdict requires the runtime role to be unprivileged', () => {
  const ev = CODE.slice(CODE.indexOf('function evaluate'));
  assert.match(ev, /ci\.is_superuser\s*===\s*false/);
  assert.match(ev, /ci\.bypassrls\s*===\s*false/);
  assert.match(ev, /rt\.is_superuser\s*===\s*false/);
  assert.match(ev, /rt\.bypassrls\s*===\s*false/);
});

test('a valid verdict requires the privileged role contracts to hold', () => {
  const ev = CODE.slice(CODE.indexOf('function evaluate'));
  // definer role: NOLOGIN, not superuser, BYPASSRLS
  assert.match(ev, /rr\.can_login\s*===\s*false/);
  assert.match(ev, /rr\.is_superuser\s*===\s*false/);
  assert.match(ev, /rr\.bypassrls\s*===\s*true/);
  // schema owner: NOLOGIN, not superuser, no BYPASSRLS
  assert.match(ev, /so\.can_login\s*===\s*false/);
  assert.match(ev, /so\.is_superuser\s*===\s*false/);
  assert.match(ev, /so\.bypassrls\s*===\s*false/);
});

test('a valid verdict requires no privileged role membership', () => {
  const ev = CODE.slice(CODE.indexOf('function evaluate'));
  assert.match(ev, /runtime_in_auth_resolver\s*===\s*false/);
  assert.match(ev, /runtime_in_auth_schema_owner\s*===\s*false/);
});

test('a valid verdict requires RLS and FORCE RLS on both source tables', () => {
  const ev = CODE.slice(CODE.indexOf('function evaluate'));
  assert.match(ev, /q\.rls_enabled\s*===\s*true/);
  assert.match(ev, /q\.force_rls\s*===\s*true/);
  assert.match(ev, /j\.rls_enabled\s*===\s*true/);
  assert.match(ev, /j\.force_rls\s*===\s*true/);
});

test('a valid verdict requires the verified read-only transaction', () => {
  const ev = CODE.slice(CODE.indexOf('function evaluate'));
  assert.match(ev, /ci\.transaction_read_only\s*===\s*true/);
  assert.match(ev, /ci\.database\s*===\s*ALLOWED_DB/);
});

test('the probe never attempts to repair a mismatched state', () => {
  const ev = CODE.slice(CODE.indexOf('function evaluate'));
  assert.ok(!/\b(CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE)\b/.test(ev),
    'evaluation must observe and report, never remediate');
});

// ---------------------------------------------------------------------------
// Exit behaviour
// ---------------------------------------------------------------------------

test('failure sets a non-zero exit code without calling process.exit', () => {
  assert.match(CODE, /process\.exitCode\s*=\s*1/);
  assert.ok(!/process\.exit\(/.test(CODE),
    'process.exit would risk truncating cleanup; exitCode must be assigned instead');
});

test('an invalid state exits non-zero after cleanup has completed', () => {
  const tail = CODE.slice(CODE.indexOf('if (require.main === module)'));
  // The entry point emits the PROBE_STATE_INVALID category (via CAT.INVALID)
  // and sets a failing exit code.
  assert.match(tail, /CAT\.INVALID/);
  assert.match(CODE, /INVALID:\s*'PROBE_STATE_INVALID'/);
  assert.match(tail, /process\.exitCode\s*=\s*1/);
  // evaluate() and the stdout write both happen after the finally block
  assert.ok(CODE.indexOf('} finally {') < CODE.indexOf('const valid = evaluate(result)'));
});

// ---------------------------------------------------------------------------
// The probe is inert unless a human runs it
// ---------------------------------------------------------------------------

test('the probe only runs when invoked directly', () => {
  assert.match(CODE, /if\s*\(require\.main === module\)/,
    'importing the probe must have no side effect');
});

test('no application code, migration, package script or test invokes the probe', () => {
  const NEEDLE = 'phase66a_readonly_metadata_probe';
  const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);
  const hits = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(js|cjs|mjs|json|sql|ya?ml)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // The probe itself and this contract test are the only permitted mentions.
      if (full === PROBE_PATH || full === __filename) continue;
      if (fs.readFileSync(full, 'utf8').includes(NEEDLE)) hits.push(full);
    }
  };

  for (const sub of ['src', 'scripts', 'test']) {
    const dir = path.join(SERVER_DIR, sub);
    if (fs.existsSync(dir)) walk(dir);
  }
  const pkg = path.join(SERVER_DIR, 'package.json');
  if (fs.existsSync(pkg) && fs.readFileSync(pkg, 'utf8').includes(NEEDLE)) hits.push(pkg);

  assert.deepEqual(hits, [], 'the probe must have no automated invocation path');
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

test('the probe contains no secret of any kind', () => {
  assert.ok(!/postgres(ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/i.test(SRC), 'no credential-bearing URL');
  assert.ok(!/(password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/i.test(SRC), 'no password literal');
  assert.ok(!/BEGIN (RSA|OPENSSH|PRIVATE) KEY/.test(SRC), 'no private key');
  assert.ok(!/\b(JWT_SECRET|API_KEY|HMAC_SECRET)\b/.test(SRC), 'no secret env name');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10}/.test(SRC), 'no embedded token');
});

test('this contract test never executes the probe or opens a connection', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  // The decisive check: this file loads nothing but Node built-ins. That rules
  // out the driver, the probe and any process helper in one assertion, without
  // the self-matching problems of scanning for forbidden substrings in a file
  // whose whole job is to name them.
  // Only real top-level import declarations count; the many require('...')
  // strings this file scans FOR inside the probe are assertion data, not loads.
  const loaded = [...new Set([...self.matchAll(/^const\s+[^=\n]+=\s*require\('([^']+)'\)/gm)]
    .map((m) => m[1]))].sort();
  assert.deepEqual(loaded, ['node:assert/strict', 'node:fs', 'node:path', 'node:test'],
    'the contract test must load only Node built-ins — never the driver or the probe');
  // And it must never evaluate the probe as code. (A connection pool is already
  // impossible: `pg` is not among the modules loaded above.)
  assert.ok(!/\brequire\(\s*PROBE_PATH\s*\)/.test(self), 'the probe must never be imported');
  assert.ok(!/\bexecFileSync|\bspawnSync\(/.test(self), 'the probe must never be run as a process');
});
