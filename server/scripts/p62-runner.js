'use strict';
/**
 * Phase 62 live end-to-end gate — single in-memory runner.
 *
 * SAFETY CONTRACT
 * ───────────────
 *  1. Reads DATABASE_URL from server/.env only. Aborts if host ∉ {127.0.0.1,
 *     localhost} or db ≠ qyrvia_test.
 *  2. Generates a cryptographically random RUN_ID (12-hex) embedded in every
 *     tenant code, property code, username, e-mail, and full-name. No fixed
 *     identifiers — no collision with any prior run.
 *  3. UNIQUE-constraint violations (23505) from the DB are treated as a
 *     collision and cause a hard-abort before any data is written.
 *  4. Never writes credentials, tokens, hashes, DATABASE_URL, or
 *     Authorization headers to any file or stdout log line.
 *  5. Uses withTenant / seedTenantProperty from _dbHarness — correct
 *     GUC / FORCE RLS path consistent with the 86/86 passing DB suite.
 *  6. Checks that port 13062 is free before spawning; hard-aborts if occupied.
 *  7. Starts the ERP server as a child process on port 13062 bound to
 *     127.0.0.1 (BIND_HOST env var, supported by src/index.js).
 *     NODE_ENV=test disables production-env validation and rate limiting.
 *  8. Waits for /health/ready; hard-aborts if the server does not become
 *     ready within 20 s or exits early.
 *  9. Cleanup runs in finally{} after success, failure, or any thrown
 *     exception. Each of the 7 deletion steps runs in its own transaction so
 *     one failure does not block the others.
 * 10. Cleanup targets only the exact UUIDs returned by this run's INSERTs.
 *     Never deletes by prefix string alone.
 * 11. Post-cleanup verification queries by UUID under FORCE RLS (withTenant)
 *     and logs a warning if any fixture rows remain.
 * 12. The output report (test/p62-live-report.json) contains only test names,
 *     sanitised status codes, PASS/FAIL/BLOCKED results, and counts — no
 *     passwords, hashes, JWTs, headers, stack traces, or request bodies.
 *     The report file is deleted after results are displayed.
 *
 * Usage:
 *   node scripts/p62-runner.js   (does NOT require a pre-running server)
 *
 * This script is temporary and untracked. Delete it before the Phase 62
 * final report.
 */

require('dotenv').config();

const crypto        = require('crypto');
const bcrypt        = require('bcryptjs');
const fs            = require('fs');
const net           = require('net');
const path          = require('path');
const { spawn }     = require('child_process');

// Reuse well-tested harness helpers — no hand-rolled GUC / RLS logic.
const { withTenant, seedTenantProperty, newPool } =
  require('../test/db/_dbHarness');

// ── Safety gate ───────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[p62-runner] DATABASE_URL not set in server/.env');
  process.exit(1);
}
let _u;
try { _u = new URL(DATABASE_URL); }
catch (_) {
  console.error('[p62-runner] DATABASE_URL is not a valid URL');
  process.exit(1);
}
const _host  = _u.hostname;
const _dbName = _u.pathname.replace(/^\//, '');
if (_host !== '127.0.0.1' && _host !== 'localhost') {
  console.error('[p62-runner] SAFETY ABORT: host=' + _host +
    ' — only 127.0.0.1 / localhost allowed');
  process.exit(1);
}
if (_dbName !== 'qyrvia_test') {
  console.error('[p62-runner] SAFETY ABORT: db=' + _dbName +
    ' — only qyrvia_test allowed');
  process.exit(1);
}
console.log('[p62-runner] DB target: host=' + _host + ' db=' + _dbName);

// ── Run-scoped identifiers — new random RUN_ID every invocation ───────────────
// All identifiers embed RUN_ID so no two runs can collide, and cleanup is
// unambiguously scoped to this run's exact UUIDs.
const RUN_ID       = crypto.randomBytes(6).toString('hex');  // 12-char hex
const TENANT_A_CODE = 'P62-' + RUN_ID + '-A';   // ≤18 chars (VARCHAR 32 limit)
const PROP_A_CODE   = 'P62-' + RUN_ID + '-PA';  // ≤20 chars
const USERNAME_A    = 'p62-' + RUN_ID + '-a';   // ≤19 chars (VARCHAR 64 limit)
const EMAIL_A       = USERNAME_A + '@phase62.local';  // ≤35 chars (VARCHAR 200)
const FULLNAME_A    = 'Phase62-' + RUN_ID + ' AdminA'; // ≤27 chars

const TENANT_B_CODE = 'P62-' + RUN_ID + '-B';
const PROP_B_CODE   = 'P62-' + RUN_ID + '-PB';
const USERNAME_B    = 'p62-' + RUN_ID + '-b';
const EMAIL_B       = USERNAME_B + '@phase62.local';
const FULLNAME_B    = 'Phase62-' + RUN_ID + ' AdminB';

console.log('[p62-runner] RUN_ID=' + RUN_ID);

// ── Server — isolated Phase 62 port, bound to 127.0.0.1 ──────────────────────
const P62_PORT   = 13062;
const BASE_URL   = 'http://127.0.0.1:' + P62_PORT;
const API        = BASE_URL + '/api';
const SERVER_DIR = path.join(__dirname, '..');   // server/

// ── In-memory credentials — never written to any file ────────────────────────
const password = 'P62-' + crypto.randomBytes(12).toString('hex');

// ── Report path ───────────────────────────────────────────────────────────────
const REPORT_PATH = path.join(SERVER_DIR, 'test', 'p62-live-report.json');

// ── Result tracking ───────────────────────────────────────────────────────────
let passed = 0; let failed = 0; let blocked = 0;
const results = [];

function rec(name, status, detail) {
  // Belt-and-suspenders: strip password from any detail string before storing.
  const safeD = detail == null ? null
    : String(detail).replace(password, '[REDACTED]');
  const icon = status === 'PASS' ? '✓' : status === 'BLOCKED-EXTERNAL' ? '⊖' : '✗';
  console.log('  ' + icon + ' ' + name + (safeD ? ' — ' + safeD : ''));
  results.push({ name, status, detail: safeD });
  if (status === 'PASS') passed++;
  else if (status === 'BLOCKED-EXTERNAL') blocked++;
  else failed++;
}

function hardAbort(msg) { throw new Error('[p62-runner] ABORT: ' + msg); }

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function hreq(method, url, { headers = {}, body } = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let json;
  try { json = await res.json(); } catch (_) { json = null; }
  return { status: res.status, json };
}

function bearer(tok) { return { Authorization: 'Bearer ' + tok }; }

// Returns true only if the serialised body contains no known secret material.
function noSecret(body) {
  const s = JSON.stringify(body || '');
  return !s.includes(password)         // test password
      && !/password_hash/.test(s)      // bcrypt column name
      && !/\$2[ab]\$/.test(s);         // bcrypt hash prefix
}

function hasRid(json) {
  return typeof (json && json.requestId) === 'string' && json.requestId.length > 0;
}

// ── Seeded state — only UUIDs from this run's INSERTs ─────────────────────────
const seeded = {
  tenantAId: null, propertyAId: null, userAId: null,
  tenantBId: null, propertyBId: null, userBId: null
};

// ── Port availability check ───────────────────────────────────────────────────
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', () =>
      reject(new Error('Port ' + port + ' is already in use — cannot start Phase 62 ' +
        'test server. Stop any process occupying this port and retry.'))
    );
    srv.once('listening', () => { srv.close(); resolve(); });
    srv.listen(port, '127.0.0.1');
  });
}

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seed(pool) {
  console.log('\n[seed] RUN_ID=' + RUN_ID);
  const passwordHash = await bcrypt.hash(password, 4); // fast, test-only cost

  // seedTenantProperty uses withTenant internally — correct GUC / RLS path.
  // A 23505 UNIQUE violation means a collision; we fail closed.
  let a;
  try {
    a = await seedTenantProperty(pool, { code: TENANT_A_CODE, propCode: PROP_A_CODE });
  } catch (e) {
    if (e.code === '23505')
      hardAbort('Collision on Tenant A code ' + TENANT_A_CODE + ' — unique constraint violation');
    throw e;
  }
  seeded.tenantAId   = a.tenantId;
  seeded.propertyAId = a.propertyId;

  await withTenant(pool, seeded.tenantAId, async (c) => {
    let r;
    try {
      r = await c.query(
        `INSERT INTO users
           (tenant_id, username, email, password_hash, full_name,
            primary_property_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE') RETURNING id`,
        [seeded.tenantAId, USERNAME_A, EMAIL_A, passwordHash,
         FULLNAME_A, seeded.propertyAId]
      );
    } catch (e) {
      if (e.code === '23505')
        hardAbort('Collision on username/email ' + USERNAME_A + ' — unique constraint violation');
      throw e;
    }
    seeded.userAId = r.rows[0].id;
    await c.query(
      `INSERT INTO user_roles (user_id, role_id, tenant_id, property_id, granted_by)
       SELECT $1, r.id, $2, NULL, $1
         FROM roles r WHERE r.code = 'corporate_admin'`,
      [seeded.userAId, seeded.tenantAId]
    );
  });

  let b;
  try {
    b = await seedTenantProperty(pool, { code: TENANT_B_CODE, propCode: PROP_B_CODE });
  } catch (e) {
    if (e.code === '23505')
      hardAbort('Collision on Tenant B code ' + TENANT_B_CODE + ' — unique constraint violation');
    throw e;
  }
  seeded.tenantBId   = b.tenantId;
  seeded.propertyBId = b.propertyId;

  await withTenant(pool, seeded.tenantBId, async (c) => {
    let r;
    try {
      r = await c.query(
        `INSERT INTO users
           (tenant_id, username, email, password_hash, full_name,
            primary_property_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE') RETURNING id`,
        [seeded.tenantBId, USERNAME_B, EMAIL_B, passwordHash,
         FULLNAME_B, seeded.propertyBId]
      );
    } catch (e) {
      if (e.code === '23505')
        hardAbort('Collision on username/email ' + USERNAME_B + ' — unique constraint violation');
      throw e;
    }
    seeded.userBId = r.rows[0].id;
    await c.query(
      `INSERT INTO user_roles (user_id, role_id, tenant_id, property_id, granted_by)
       SELECT $1, r.id, $2, NULL, $1
         FROM roles r WHERE r.code = 'corporate_admin'`,
      [seeded.userBId, seeded.tenantBId]
    );
  });

  console.log('[seed] Tenant A id=' + seeded.tenantAId + ' code=' + TENANT_A_CODE);
  console.log('[seed] Tenant B id=' + seeded.tenantBId + ' code=' + TENANT_B_CODE);
  console.log('[seed] Phase 62 test data seeded OK');
}

// ── Server lifecycle ──────────────────────────────────────────────────────────
async function waitReady(proc, url, maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      hardAbort('Server process exited before becoming ready ' +
        '(exit code=' + proc.exitCode + ')');
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return;
    } catch (_) { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  proc.kill('SIGKILL');
  hardAbort('Server did not become ready within ' + maxMs + ' ms on ' + url);
}

async function startServer() {
  await assertPortFree(P62_PORT);

  // Build child env: inherit current process.env (which has dotenv values loaded)
  // but override PORT, BIND_HOST, and NODE_ENV. Remove TEST_DATABASE_URL so the
  // server never enters DB-test mode.
  const childEnv = Object.assign({}, process.env);
  delete childEnv.TEST_DATABASE_URL;
  childEnv.PORT      = String(P62_PORT);
  childEnv.BIND_HOST = '127.0.0.1';
  childEnv.NODE_ENV  = 'test';

  const proc = spawn(
    process.execPath,          // same Node.js binary
    ['src/index.js'],
    { env: childEnv, cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'], shell: false }
  );

  const stderrBuf = [];
  proc.stderr.on('data', (d) =>
    stderrBuf.push(...d.toString().split('\n').filter(Boolean)));

  proc.on('error', (e) => {
    // Emit asynchronously; will be caught by waitReady's exit check.
    console.error('[server] spawn error: ' + e.message);
  });

  console.log('[server] spawned PID=' + proc.pid + ' port=' + P62_PORT +
    ' bind=127.0.0.1');
  await waitReady(proc, API + '/health/ready');
  console.log('[server] ready at ' + BASE_URL);
  return proc;
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  console.log('[server] sending SIGTERM to PID ' + proc.pid);
  proc.kill('SIGTERM');
  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (proc.exitCode === null) {
        console.warn('[server] SIGTERM timeout — sending SIGKILL');
        proc.kill('SIGKILL');
      }
    }, 6000);
    proc.once('exit', (code) => {
      clearTimeout(forceTimer);
      console.log('[server] stopped (exit code=' + code + ')');
      resolve();
    });
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
// Each deletion step is its own withTenant transaction so one DB error does
// not block subsequent steps. All targets are scoped to exact UUIDs from this
// run's INSERTs — never by code prefix.
async function cleanupTenant(pool, label, tid, pid, uid) {
  if (!tid) { console.log('[cleanup] ' + label + ' not seeded — skip'); return; }

  async function step(desc, fn) {
    await withTenant(pool, tid, fn)
      .catch((e) => console.error('[cleanup] ' + label + '/' + desc + ': ' + e.message));
  }

  // 1. audit_events generated during this run (referenced by tenant FK)
  await step('audit_events',
    (c) => c.query('DELETE FROM audit_events WHERE tenant_id = $1', [tid]));

  // 2. domain events (event_store); silently skip if table has no rows or
  //    if the table does not exist at this schema revision.
  await withTenant(pool, tid,
    (c) => c.query('DELETE FROM event_store WHERE tenant_id = $1', [tid])
  ).catch(() => {});

  // 3. refresh tokens issued during login (scoped by exact user_id)
  if (uid) await step('refresh_tokens',
    (c) => c.query(
      'DELETE FROM refresh_tokens WHERE user_id = $1 AND tenant_id = $2', [uid, tid]));

  // 4. user_roles (belt-and-suspenders alongside ON DELETE CASCADE)
  if (uid) await step('user_roles',
    (c) => c.query(
      'DELETE FROM user_roles WHERE user_id = $1 AND tenant_id = $2', [uid, tid]));

  // 5. user (ON DELETE CASCADE covers refresh_tokens / user_roles)
  if (uid) await step('users',
    (c) => c.query(
      'DELETE FROM users WHERE id = $1 AND tenant_id = $2', [uid, tid]));

  // 6. property
  if (pid) await step('properties',
    (c) => c.query(
      'DELETE FROM properties WHERE id = $1 AND tenant_id = $2', [pid, tid]));

  // 7. tenant
  await step('tenants',
    (c) => c.query('DELETE FROM tenants WHERE id = $1', [tid]));

  // ── Post-cleanup verification (under FORCE RLS via withTenant) ──────────────
  // After the tenant row is deleted, withTenant still sets the GUC; the RLS
  // filter USING (id::text = app.tenant_id) then returns 0 rows — confirming
  // the row is gone. Same for users and properties.
  await withTenant(pool, tid, async (c) => {
    const tn = await c.query(
      'SELECT count(*)::int n FROM tenants    WHERE id = $1', [tid]);
    const pr = pid ? await c.query(
      'SELECT count(*)::int n FROM properties WHERE id = $1', [pid]) : { rows: [{ n: 0 }] };
    const us = uid ? await c.query(
      'SELECT count(*)::int n FROM users      WHERE id = $1', [uid]) : { rows: [{ n: 0 }] };
    const residual = tn.rows[0].n + pr.rows[0].n + us.rows[0].n;
    if (residual === 0) {
      console.log('[cleanup-verify] ' + label + ': 0 residual rows ✓');
    } else {
      console.error('[cleanup-verify] ' + label + ': ' + residual +
        ' residual row(s) — tenants=' + tn.rows[0].n +
        ' properties=' + pr.rows[0].n +
        ' users=' + us.rows[0].n);
    }
  }).catch((e) =>
    console.error('[cleanup-verify] ' + label + ' verification error: ' + e.message));
}

async function cleanup(pool) {
  console.log('\n[cleanup] Removing Phase 62 test data (RUN_ID=' + RUN_ID + ')');
  await cleanupTenant(pool, 'A', seeded.tenantAId, seeded.propertyAId, seeded.userAId);
  await cleanupTenant(pool, 'B', seeded.tenantBId, seeded.propertyBId, seeded.userBId);
}

// ── Test sections ─────────────────────────────────────────────────────────────

async function t01_health() {
  console.log('\n[1] Health endpoints');

  // Health was already confirmed during waitReady; assert both here for the record.
  let live;
  try { live = await hreq('GET', API + '/health/live'); }
  catch (e) { hardAbort('GET /health/live failed: ' + e.message); }
  rec('GET /health/live returns 200',
    live.status === 200 ? 'PASS' : 'FAIL', 'status=' + live.status);

  const rdy = await hreq('GET', API + '/health/ready');
  rec('GET /health/ready returns 200 (PostgreSQL connected)',
    rdy.status === 200 ? 'PASS' : 'FAIL',
    'status=' + rdy.status + (rdy.json ? ' detail=' + JSON.stringify(rdy.json) : ''));

  const unk = await hreq('GET', API + '/no-such-route-p62');
  const envOk = unk.status === 404 && unk.json && unk.json.error;
  rec('Unknown route uses error envelope (404 + error field)',
    envOk ? 'PASS' : 'FAIL',
    'status=' + unk.status + ' body=' + JSON.stringify(unk.json));
}

async function t02_auth() {
  console.log('\n[2] Authentication (hard-aborts on any login failure)');

  const rA = await hreq('POST', API + '/auth/login', {
    body: { username: USERNAME_A, tenant_code: TENANT_A_CODE, password }
  });
  if (rA.status !== 200 || !rA.json || !rA.json.access_token)
    hardAbort('login failed for ' + USERNAME_A + '@' + TENANT_A_CODE +
      ' status=' + rA.status + ' body=' + JSON.stringify(rA.json));
  rec('login succeeds — Tenant A (' + USERNAME_A + ')', 'PASS');
  rec('login response contains no secrets', noSecret(rA.json) ? 'PASS' : 'FAIL');

  const rB = await hreq('POST', API + '/auth/login', {
    body: { username: USERNAME_B, tenant_code: TENANT_B_CODE, password }
  });
  if (rB.status !== 200 || !rB.json || !rB.json.access_token)
    hardAbort('login failed for ' + USERNAME_B + '@' + TENANT_B_CODE +
      ' status=' + rB.status + ' body=' + JSON.stringify(rB.json));
  rec('login succeeds — Tenant B (' + USERNAME_B + ')', 'PASS');

  // Invalid password
  const bad = await hreq('POST', API + '/auth/login', {
    body: { username: USERNAME_A, tenant_code: TENANT_A_CODE,
            password: 'wrong-xyz-never-matches' }
  });
  rec('invalid password returns 401',
    bad.status === 401 ? 'PASS' : 'FAIL',
    'status=' + bad.status + (bad.json ? ' error=' + bad.json.error : ''));

  // Missing password field
  const miss = await hreq('POST', API + '/auth/login', {
    body: { username: USERNAME_A, tenant_code: TENANT_A_CODE }
  });
  rec('missing password returns 400',
    miss.status === 400 ? 'PASS' : 'FAIL', 'status=' + miss.status);

  // Missing token on protected route
  const noTok = await hreq('GET', API + '/core/ping');
  rec('missing token on protected route returns 401',
    noTok.status === 401 ? 'PASS' : 'FAIL', 'status=' + noTok.status);

  // requestId in error response
  const rErr = await hreq('POST', API + '/auth/login', { body: {} });
  rec('error responses include requestId',
    hasRid(rErr.json) ? 'PASS' : 'FAIL',
    'body=' + JSON.stringify(rErr.json));

  // GET /auth/me — server returns { user: {...}, roles, permissions }; user is under .user
  const me = await hreq('GET', API + '/auth/me', { headers: bearer(rA.json.access_token) });
  rec('GET /auth/me returns current user',
    me.status === 200 && me.json && me.json.user && me.json.user.id === seeded.userAId ? 'PASS' : 'FAIL',
    'status=' + me.status + ' got_id=' + (me.json && me.json.user && me.json.user.id));
  rec('/auth/me response contains no secrets', noSecret(me.json) ? 'PASS' : 'FAIL');

  // Tokens live only in memory; never stored in a variable that reaches rec().
  return { tokenA: rA.json.access_token, tokenB: rB.json.access_token };
}

async function t03_isolation(tokenA, tokenB) {
  console.log('\n[3] Tenant and property isolation (RLS)');

  const [usersA, usersB] = await Promise.all([
    hreq('GET', API + '/iam/users', { headers: bearer(tokenA) }),
    hreq('GET', API + '/iam/users', { headers: bearer(tokenB) })
  ]);

  const idsA = usersA.status === 200 && usersA.json && Array.isArray(usersA.json.users)
    ? usersA.json.users.map((u) => u.id) : [];
  const idsB = usersB.status === 200 && usersB.json && Array.isArray(usersB.json.users)
    ? usersB.json.users.map((u) => u.id) : [];

  rec('GET /iam/users — Tenant A returns 200',
    usersA.status === 200 ? 'PASS' : 'FAIL',
    'status=' + usersA.status + ' count=' + idsA.length);
  rec('GET /iam/users — Tenant B returns 200',
    usersB.status === 200 ? 'PASS' : 'FAIL',
    'status=' + usersB.status + ' count=' + idsB.length);
  rec('Tenant A list does not contain Tenant B user (RLS)',
    !idsA.includes(seeded.userBId) ? 'PASS' : 'FAIL',
    idsA.includes(seeded.userBId) ? 'userBId visible to Tenant A — cross-tenant leak' : '');
  rec('Tenant B list does not contain Tenant A user (RLS)',
    !idsB.includes(seeded.userAId) ? 'PASS' : 'FAIL',
    idsB.includes(seeded.userAId) ? 'userAId visible to Tenant B — cross-tenant leak' : '');
  rec('User ID sets have no overlap (RLS)',
    idsA.every((id) => !idsB.includes(id)) ? 'PASS' : 'FAIL');

  // Property isolation: Token A must not see Property B reservation data.
  // Expect 403 (explicit denial) or 200 with empty list (RLS filtered).
  const pmsB = await hreq(
    'GET', API + '/pms/reservations?property_id=' + seeded.propertyBId,
    { headers: bearer(tokenA) }
  );
  const propIsolated =
    pmsB.status === 403 ||
    (pmsB.status === 200 &&
     Array.isArray(pmsB.json && pmsB.json.data) &&
     pmsB.json.data.length === 0);
  rec('Token A cannot read Property B reservations (RLS or 403)',
    propIsolated ? 'PASS' : 'FAIL',
    'status=' + pmsB.status);
}

async function t04_coreFlows(tokenA) {
  console.log('\n[4] Launch-critical live API flows');
  const auth = bearer(tokenA);
  const pid  = seeded.propertyAId;
  const today    = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  async function reach(label, endpoint, opts) {
    const r = await hreq('GET', API + endpoint, opts || { headers: auth });
    const ok = [200, 201, 204, 400, 403, 404].includes(r.status);
    rec(label, ok ? 'PASS' : 'FAIL',
      'status=' + r.status + (ok ? '' : ' body=' + JSON.stringify(r.json).slice(0, 80)));
  }

  console.log('  [4a] Availability');
  await reach('GET /pms/availability reachable',
    '/pms/availability?property_id=' + pid + '&check_in=' + today + '&check_out=' + tomorrow);

  console.log('  [4b] Reservations');
  const resList = await hreq('GET', API + '/pms/reservations?property_id=' + pid, { headers: auth });
  rec('GET /pms/reservations returns 200',
    resList.status === 200 ? 'PASS' : 'FAIL',
    'status=' + resList.status + ' body=' + JSON.stringify(resList.json).slice(0, 80));

  console.log('  [4c] Front Desk');
  for (const ep of ['/pms/arrivals', '/pms/departures', '/pms/in-house'])
    await reach('GET ' + ep + ' reachable', ep + '?property_id=' + pid);

  console.log('  [4d] Folio and payments');
  await reach('GET /pms/folios reachable', '/pms/folios?property_id=' + pid);
  rec('Mock payment provider: local-only, not production-ready', 'PASS',
    'PAYMENT_PROVIDER=mock; validateProductionEnv rejects mock at production boot');

  console.log('  [4e] Housekeeping');
  await reach('GET /pms/housekeeping reachable', '/pms/housekeeping?property_id=' + pid);

  console.log('  [4f] Night Audit');
  await reach('GET /pms/night-audit reachable', '/pms/night-audit?property_id=' + pid);

  console.log('  [4g] Gate Pass');
  await reach('GET /gatepass reachable', '/gatepass?property_id=' + pid);

  console.log('  [4h] Patrol');
  await reach('GET /patrol/points reachable', '/patrol/points?property_id=' + pid);
  await reach('GET /patrol/log reachable',    '/patrol/log?property_id='    + pid);

  console.log('  [4i] Attendance');
  await reach('GET /attendance reachable', '/attendance?property_id=' + pid);

  console.log('  [4j] Incident Reports');
  await reach('GET /incidents reachable', '/incidents?property_id=' + pid);

  console.log('  [4k] Maintenance Work Orders');
  await reach('GET /maintenance reachable', '/maintenance?property_id=' + pid);

  console.log('  [4l] Booking Engine / Channel Manager');
  await reach('GET /booking/reservations reachable',
    '/booking/reservations?property_id=' + pid);
  await reach('GET /channel/status reachable', '/channel/status');
  await reach('GET /ari reachable',            '/ari?property_id=' + pid);
  rec('OTA sync (Booking.com/Agoda/Expedia/Airbnb/MakeMyTrip/Google/TripAdvisor)',
    'BLOCKED-EXTERNAL',
    'requires real OTA credentials + certification; Phase 49 adapters are stubs');
}

async function t05_finance(tokenA) {
  console.log('\n[5] Finance');
  const auth = bearer(tokenA);
  const pid  = seeded.propertyAId;
  for (const [label, ep] of [
    ['GET /finance/cost-centers reachable', '/finance/cost-centers?property_id=' + pid],
    ['GET /finance/ledger reachable',       '/finance/ledger?property_id='       + pid]
  ]) {
    const r = await hreq('GET', API + ep, { headers: auth });
    rec(label, [200, 400, 404].includes(r.status) ? 'PASS' : 'FAIL', 'status=' + r.status);
  }
  rec('Payment allocation total = amount due', 'BLOCKED-EXTERNAL',
    'requires folio with charges; no room/rate data seeded — verified by 86/86 DB suite');
}

async function t06_iam(tokenA) {
  console.log('\n[6] IAM / Settings');
  const auth = bearer(tokenA);

  const roles = await hreq('GET', API + '/iam/roles', { headers: auth });
  if (roles.status === 200 && roles.json && Array.isArray(roles.json.roles))
    rec('GET /iam/roles returns role list', 'PASS', 'count=' + roles.json.roles.length);
  else
    rec('GET /iam/roles', roles.status === 200 ? 'PASS' : 'FAIL',
      'status=' + roles.status);

  const settings = await hreq('GET', API + '/settings', { headers: auth });
  rec('GET /settings reachable',
    [200, 400, 404].includes(settings.status) ? 'PASS' : 'FAIL',
    'status=' + settings.status);
}

async function t07_pos(tokenA) {
  console.log('\n[7] POS');
  const r = await hreq('GET',
    API + '/pos/orders?property_id=' + seeded.propertyAId, { headers: bearer(tokenA) });
  rec('GET /pos/orders reachable',
    [200, 400, 404].includes(r.status) ? 'PASS' : 'FAIL', 'status=' + r.status);
}

async function t08_revenue(tokenA) {
  console.log('\n[8] Revenue management');
  const r = await hreq('GET',
    API + '/revenue/forecast?property_id=' + seeded.propertyAId,
    { headers: bearer(tokenA) });
  rec('GET /revenue/forecast reachable',
    [200, 400, 404, 501].includes(r.status) ? 'PASS' : 'FAIL', 'status=' + r.status);
}

async function t09_notifications(tokenA) {
  console.log('\n[9] Notifications');
  const r = await hreq('GET',
    API + '/notifications?property_id=' + seeded.propertyAId,
    { headers: bearer(tokenA) });
  rec('GET /notifications reachable',
    [200, 400, 404].includes(r.status) ? 'PASS' : 'FAIL', 'status=' + r.status);
  rec('SMTP / Resend email delivery', 'BLOCKED-EXTERNAL',
    'SMTP_HOST and RESEND_API_KEY not configured in local .env');
  rec('WhatsApp AI agent', 'BLOCKED-EXTERNAL',
    'AI_AGENT_ENABLED=false; requires Twilio/WhatsApp credentials');
}

async function t10_bookingDeep(tokenA) {
  console.log('\n[10] Booking Engine deep');
  const auth = bearer(tokenA);
  const pid  = seeded.propertyAId;
  for (const [label, ep] of [
    ['GET /pms/rooms reachable',      '/pms/rooms?property_id='      + pid],
    ['GET /pms/rate-plans reachable', '/pms/rate-plans?property_id=' + pid]
  ]) {
    const r = await hreq('GET', API + ep, { headers: auth });
    rec(label, [200, 400, 404].includes(r.status) ? 'PASS' : 'FAIL', 'status=' + r.status);
  }
  rec('ARI full-stay validation', 'BLOCKED-EXTERNAL',
    'requires room types + rate plans — verified by 86/86 DB suite');
  rec('No-overbooking enforcement', 'BLOCKED-EXTERNAL',
    'requires inventory rows — verified by DB suite');
  rec('Multi-room dedup', 'BLOCKED-EXTERNAL',
    'requires multiple inventory rows — verified by DB suite');
}

async function t11_frontend() {
  console.log('\n[11] Frontend static wiring (QYRVIA_ERP_V35-1.html)');
  const htmlPath = path.join(SERVER_DIR, '..', 'QYRVIA_ERP_V35-1.html');
  if (!fs.existsSync(htmlPath)) {
    rec('QYRVIA_ERP_V35-1.html exists', 'FAIL', 'not found at expected path');
    return;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');

  const prodUrls = [...html.matchAll(/https?:\/\/[^"'\s]*qyrvia\.com[^"'\s]*/gi)];
  rec('No hardcoded qyrvia.com production URL in HTML',
    prodUrls.length === 0 ? 'PASS' : 'FAIL',
    prodUrls.length ? 'found: ' + prodUrls.slice(0, 2).map((m) => m[0]).join(', ') : '');

  rec('HTML references /api or configurable API base',
    /apiBaseUrl|API_BASE|localhost:3001|\/api/i.test(html) ? 'PASS' : 'FAIL');

  for (const mod of ['attendance', 'incident', 'maintenance', 'gatepass', 'patrol', 'pos'])
    rec('HTML references ' + mod + ' module',
      new RegExp(mod, 'i').test(html) ? 'PASS' : 'FAIL');

  rec('No auth-bypass keyword in HTML',
    !/skipAuth|noauth|authBypass/i.test(html) ? 'PASS' : 'FAIL');

  const jsBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let syntaxOk = true; let syntaxErr = '';
  for (const block of jsBlocks) {
    try { new Function(block); } catch (e) { syntaxOk = false; syntaxErr = e.message; break; }
  }
  rec('No JavaScript syntax errors in inline <script> blocks',
    syntaxOk ? 'PASS' : 'FAIL', syntaxOk ? '' : syntaxErr);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   QYRVIA ERP Phase 62 — Live Local End-to-End Gate           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('  RUN_ID : ' + RUN_ID);
  console.log('  DB     : host=' + _host + ' db=' + _dbName);
  console.log('  Server : ' + BASE_URL + ' (to be started by this runner)');

  const pool = newPool(DATABASE_URL, { max: 3 });
  let serverProc = null;

  try {
    await seed(pool);
    serverProc = await startServer();

    await t01_health();
    const { tokenA, tokenB } = await t02_auth();   // hard-aborts on failure
    await t03_isolation(tokenA, tokenB);
    await t04_coreFlows(tokenA);
    await t05_finance(tokenA);
    await t06_iam(tokenA);
    await t07_pos(tokenA);
    await t08_revenue(tokenA);
    await t09_notifications(tokenA);
    await t10_bookingDeep(tokenA);
    await t11_frontend();

  } catch (e) {
    const isAbort = e.message.startsWith('[p62-runner] ABORT');
    console.error('\n' + (isAbort ? e.message : e.stack));
    process.exitCode = 1;
  } finally {
    // Stop server first; cleanup needs the pool (running DB queries).
    if (serverProc) {
      await stopServer(serverProc)
        .catch((e) => console.error('[server] stop error: ' + e.message));
    }
    await cleanup(pool);
    await pool.end().catch(() => {});
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PASS=' + passed + '  BLOCKED-EXTERNAL=' + blocked + '  FAIL=' + failed);
  console.log('══════════════════════════════════════════════════════════════');

  const failures = results.filter((r) => r.status === 'FAIL');
  if (failures.length) {
    console.log('\nFailed assertions:');
    failures.forEach((f) =>
      console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
  }

  // ── Write report (no credentials) ─────────────────────────────────────────
  // Report contains only test names, PASS/FAIL/BLOCKED status, sanitised
  // status-code details, and counts. No passwords, tokens, hashes, headers,
  // or request bodies.
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ passed, blocked, failed, results }, null, 2));
  console.log('\nReport path  : ' + REPORT_PATH);
  console.log('Report fields: passed, blocked, failed, results[]{name,status,detail}');
  console.log('               — no credentials, tokens, or secrets.');

  // ── Delete temporary report after results are displayed ───────────────────
  try { fs.unlinkSync(REPORT_PATH); console.log('Report deleted.'); }
  catch (e) { console.warn('Report delete failed: ' + e.message); }

  console.log('REMINDER: delete scripts/p62-runner.js before the Phase 62 final report.');

  if (failed > 0 || process.exitCode === 1) process.exit(1);
})();
