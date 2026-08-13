'use strict';

/**
 * Phase 66A-B2N-D — guarded database test for the ARI outbox tenant resolver
 * and drain worker.
 *
 * Runs the REAL committed modules — worker_resolvers.due_ari_outbox_tenants,
 * ariOutboxTenantResolver, ariOutboxWorker and the tenantAriOutbox wrappers —
 * against REAL PostgreSQL as the ordinary non-superuser, NOBYPASSRLS
 * qyrvia_test role. No mock database, no fake pool.
 *
 * PREREQUISITES (both are OPERATOR steps, never performed by this test):
 *   1. the appropriate superuser bootstrap has installed
 *      worker_resolvers.due_ari_outbox_tenants;
 *   2. migration 0089 has been applied, granting the six column-level SELECTs.
 * If the resolver is absent the whole file fails closed with a clear message
 * rather than silently reporting "no tenants have work" — that vacuous zero is
 * exactly the failure mode this phase exists to prevent.
 *
 * This test performs NO DDL (no CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE), runs
 * no migration, changes no role, no ownership and no RLS setting. It only
 * inserts, reads and deletes its own tenant-scoped fixture rows.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const H = require('./_dbHarness');
const { buildAriOutboxTenantResolver } = require('../../src/ari/outbox/ariOutboxTenantResolver');
const { buildAriOutboxWorker } = require('../../src/ari/outbox/ariOutboxWorker');
const ariOutboxWrappers = require('../../src/ari/outbox/tenantAriOutbox');

// ---------------------------------------------------------------------------
// The complete nine-clause local-database guard.
//
// Every clause is evaluated independently and PASS_ALL_9_CLAUSES is printed
// only when all nine passed. Nothing about the URL — protocol, host, port,
// database, username, password, query or fragment — is ever printed.
// ---------------------------------------------------------------------------

const RAW_URL = process.env.TEST_DATABASE_URL || '';

function nineClauseGuard(raw) {
  const clauses = {
    GUARD_01_PROTOCOL: false,
    GUARD_02_HOST: false,
    GUARD_03_PORT: false,
    GUARD_04_DATABASE: false,
    GUARD_05_USERNAME: false,
    GUARD_06_NOT_POSTGRES: false,
    GUARD_07_PASSWORD_PRESENT: false,
    GUARD_08_QUERY_EMPTY: false,
    GUARD_09_FRAGMENT_EMPTY: false
  };
  let u = null;
  try { u = new URL(raw); } catch (e) { u = null; }
  if (!u) return { ok: false, clauses, parsed: false };

  const user = decodeURIComponent(u.username || '');
  const pass = decodeURIComponent(u.password || '');

  clauses.GUARD_01_PROTOCOL          = u.protocol === 'postgres:' || u.protocol === 'postgresql:';
  clauses.GUARD_02_HOST              = u.hostname === '127.0.0.1';
  clauses.GUARD_03_PORT              = u.port === '5432';
  clauses.GUARD_04_DATABASE          = u.pathname === '/qyrvia_test';
  clauses.GUARD_05_USERNAME          = user === 'qyrvia_test';
  clauses.GUARD_06_NOT_POSTGRES      = user !== 'postgres';
  clauses.GUARD_07_PASSWORD_PRESENT  = pass.length > 0;
  clauses.GUARD_08_QUERY_EMPTY       = u.search === '';
  clauses.GUARD_09_FRAGMENT_EMPTY    = u.hash === '';

  const names = Object.keys(clauses);
  const ok = names.length === 9 && names.every((k) => clauses[k] === true);
  return { ok, clauses, parsed: true };
}

const GUARD = nineClauseGuard(RAW_URL);
const DB_ENABLED = RAW_URL.length > 0 && GUARD.ok;

if (!RAW_URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', () => {});
} else if (!GUARD.ok) {
  // Fail LOUDLY rather than skipping: a malformed or non-local URL must never
  // be quietly treated as "no database configured".
  test('nine-clause database guard', () => {
    for (const k of Object.keys(GUARD.clauses)) console.log(k + '=' + GUARD.clauses[k]);
    console.log('GUARD_CLAUSE_COUNT=' + Object.keys(GUARD.clauses).length);
    assert.fail('TEST_DATABASE_URL failed the nine-clause local guard; refusing to connect');
  });
} else {

for (const k of Object.keys(GUARD.clauses)) console.log(k + '=' + GUARD.clauses[k]);
console.log('GUARD_CLAUSE_COUNT=' + Object.keys(GUARD.clauses).length);
console.log('PASS_ALL_9_CLAUSES=true');

const D1 = '2026-09-01';
const D2 = '2026-09-30';

let pool;
let tenantA = null;
let tenantB = null;

/** A minimal, valid v1 outbox row. dedupe_key must satisfy 0088's key-version CHECK. */
function v1Key(seed) {
  return 'aob:v1:' + crypto.createHash('sha256').update(String(seed)).digest('hex');
}

async function seedTenantProperty(code) {
  const tenantId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  await H.withTenant(pool, tenantId, async (c) => {
    await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tenantId, code, code]);
    await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)',
      [propertyId, tenantId, code, code, 'LKR']);
  });
  return { tenantId, propertyId };
}

/**
 * Inserts one outbox row directly, so each test can put a tenant in an exact
 * status/timing state. Uses the tenant-bound helper, never a bare pool.
 */
async function seedOutboxRow(t, over = {}) {
  const o = Object.assign({
    status: 'PENDING',
    retryCount: 0,
    maxRetries: 5,
    nextRetryAt: null,
    leaseUntil: null,
    leaseOwner: null,
    sourceVersion: 1,
    seed: crypto.randomUUID()
  }, over);

  return H.withTenant(pool, t.tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO ari_outbox_store
         (tenant_id, property_id, event_type, resource_kind, room_type_id,
          effective_from, effective_to, source_version, dedupe_key, payload_json,
          status, retry_count, max_retries, next_retry_at, lease_until, lease_owner)
       VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY','rt-1',$3,$4,$5,$6,$7,
               $8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [t.tenantId, t.propertyId, D1, D2, o.sourceVersion, v1Key(o.seed), { source: 'db_test' },
       o.status, o.retryCount, o.maxRetries, o.nextRetryAt, o.leaseUntil, o.leaseOwner]);
    return r.rows[0].id;
  });
}

async function rowById(t, id) {
  return H.withTenant(pool, t.tenantId, async (c) => {
    const r = await c.query('SELECT * FROM ari_outbox_store WHERE tenant_id=$1 AND id=$2',
      [t.tenantId, id]);
    return r.rows[0] || null;
  });
}

async function clearOutbox(t) {
  await H.withTenant(pool, t.tenantId, (c) =>
    c.query('DELETE FROM ari_outbox_store WHERE tenant_id=$1', [t.tenantId]));
}

/**
 * Child-before-parent, tenant-scoped and parameterized. ari_inventory_grid is
 * included because its property_id references properties(id); deleting the
 * property first would raise 23503 inside the after() hook. No CASCADE, no
 * TRUNCATE, and no swallowed error — a cleanup failure must surface.
 */
async function cleanupTenant(t) {
  if (!t) return;
  await H.withTenant(pool, t.tenantId, async (c) => {
    await c.query('DELETE FROM ari_outbox_store WHERE tenant_id=$1', [t.tenantId]);
    await c.query('DELETE FROM ari_restriction_rule WHERE tenant_id=$1', [t.tenantId]);
    await c.query('DELETE FROM ari_inventory_grid WHERE tenant_id=$1', [t.tenantId]);
    await c.query('DELETE FROM properties WHERE tenant_id=$1', [t.tenantId]);
    await c.query('DELETE FROM tenants WHERE id=$1', [t.tenantId]);
  });
}

function resolver() {
  return buildAriOutboxTenantResolver({ pool });
}

function worker({ dispatch, workerId = 'db-w1', ready = true, clock } = {}) {
  return buildAriOutboxWorker({
    tenantResolver: resolver(),
    outbox: ariOutboxWrappers,
    pool,
    dispatcher: { isReady: () => ready, dispatch: dispatch || (async () => {}) },
    clock: clock || (() => new Date()),
    workerId,
    config: { isEnabled: () => true, isDispatchEnabled: () => true }
  });
}

before(async () => {
  pool = H.newPool(RAW_URL);

  // Fail closed if the operator prerequisites were not met — never let a
  // missing resolver read as "no work".
  const fn = await pool.query(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='worker_resolvers' AND p.proname='due_ari_outbox_tenants'`);
  assert.equal(fn.rows[0].n, 1,
    'worker_resolvers.due_ari_outbox_tenants is missing — run the superuser bootstrap and migration 0089 first');

  tenantA = await seedTenantProperty('DA' + crypto.randomUUID().slice(0, 6));
  tenantB = await seedTenantProperty('DB' + crypto.randomUUID().slice(0, 6));
});

after(async () => {
  try {
    await cleanupTenant(tenantA);
    await cleanupTenant(tenantB);
  } finally {
    if (pool) await pool.end();
  }
});

// ---------------------------------------------------------------------------
// R. The resolver predicate
// ---------------------------------------------------------------------------

test('R1. the resolver returns a tenant with due PENDING work', async () => {
  await clearOutbox(tenantA);
  await seedOutboxRow(tenantA, { status: 'PENDING', nextRetryAt: null });
  const out = await resolver().resolveDueTenants({ limit: 100 });
  assert.ok(out.includes(tenantA.tenantId));
});

test('R2. the resolver returns a tenant whose only row is an EXPIRED PROCESSING lease', async () => {
  await clearOutbox(tenantA);
  await seedOutboxRow(tenantA, {
    status: 'PROCESSING',
    leaseUntil: new Date(Date.now() - 60000),
    leaseOwner: 'dead-worker'
  });
  const out = await resolver().resolveDueTenants({ limit: 100 });
  assert.ok(out.includes(tenantA.tenantId), 'an expired lease is actionable — it needs recovery');
});

test('R3. a tenant whose only row has a FUTURE next_retry_at is excluded', async () => {
  await clearOutbox(tenantA);
  await seedOutboxRow(tenantA, { status: 'PENDING', nextRetryAt: new Date(Date.now() + 3600000) });
  const out = await resolver().resolveDueTenants({ limit: 100 });
  assert.ok(!out.includes(tenantA.tenantId));
});

test('R4. a tenant whose only row holds an UNEXPIRED lease is excluded', async () => {
  await clearOutbox(tenantA);
  await seedOutboxRow(tenantA, {
    status: 'PROCESSING',
    leaseUntil: new Date(Date.now() + 3600000),
    leaseOwner: 'live-worker'
  });
  const out = await resolver().resolveDueTenants({ limit: 100 });
  assert.ok(!out.includes(tenantA.tenantId), 'another worker still owns it');
});

test('R5. COMPLETED-only and DEAD_LETTER-only tenants are excluded', async () => {
  for (const status of ['COMPLETED', 'DEAD_LETTER']) {
    await clearOutbox(tenantA);
    await seedOutboxRow(tenantA, { status });
    const out = await resolver().resolveDueTenants({ limit: 100 });
    assert.ok(!out.includes(tenantA.tenantId), status + ' is terminal and never actionable');
  }
});

test('R6. a PENDING row with retry_count >= max_retries is excluded', async () => {
  await clearOutbox(tenantA);
  await seedOutboxRow(tenantA, { status: 'PENDING', retryCount: 5, maxRetries: 5 });
  const out = await resolver().resolveDueTenants({ limit: 100 });
  assert.ok(!out.includes(tenantA.tenantId), 'exhausted rows are not claimable, so not actionable');
});

test('R7. many actionable rows for one tenant yield exactly one tenant id', async () => {
  await clearOutbox(tenantA);
  for (let i = 0; i < 5; i += 1) await seedOutboxRow(tenantA, { seed: 'dup-' + i });
  const out = await resolver().resolveDueTenants({ limit: 100 });
  assert.equal(out.filter((t) => t === tenantA.tenantId).length, 1);
});

test('R8. the limit is enforced', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  await seedOutboxRow(tenantA);
  await seedOutboxRow(tenantB);
  const out = await resolver().resolveDueTenants({ limit: 1 });
  assert.equal(out.length, 1);
});

test('R9. an out-of-range limit is rejected before any SQL', async () => {
  for (const bad of [0, -1, 1001]) {
    await assert.rejects(() => resolver().resolveDueTenants({ limit: bad }), /limit must be an integer/);
  }
});

// ---------------------------------------------------------------------------
// W. The worker against real PostgreSQL
// ---------------------------------------------------------------------------

test('W1. the worker completes a due row through the tenant-bound path', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const id = await seedOutboxRow(tenantA);

  const c = await worker().tick();

  assert.ok(c.rowsCompleted >= 1);
  const after = await rowById(tenantA, id);
  assert.equal(after.status, 'COMPLETED');
  assert.equal(after.lease_owner, null);
  assert.ok(after.completed_at);
});

test('W2. a retryable dispatch failure schedules a retry and clears the lease', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const id = await seedOutboxRow(tenantA, { retryCount: 1, maxRetries: 5 });

  await worker({ dispatch: async () => { throw new Error('boom'); } }).tick();

  const after = await rowById(tenantA, id);
  assert.equal(after.status, 'PENDING');
  assert.equal(after.retry_count, 2, 'the store increments retry_count exactly once');
  assert.equal(after.attempts, 1);
  assert.ok(after.next_retry_at, 'a future retry time was recorded');
  assert.equal(after.lease_until, null);
  assert.equal(after.lease_owner, null);
});

test('W3. exhaustion dead-letters exactly once', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const id = await seedOutboxRow(tenantA, { retryCount: 4, maxRetries: 5 });

  await worker({ dispatch: async () => { throw new Error('boom'); } }).tick();

  const after = await rowById(tenantA, id);
  assert.equal(after.status, 'DEAD_LETTER');
  assert.ok(after.dead_lettered_at);
  assert.equal(after.next_retry_at, null);
  assert.equal(after.retry_count, 4, 'retry_count is preserved on dead-letter');
});

test('W4. two concurrent workers never dispatch the same row twice', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  for (let i = 0; i < 8; i += 1) await seedOutboxRow(tenantA, { seed: 'conc-' + i });

  const seenA = [];
  const seenB = [];
  const wA = worker({ workerId: 'db-wA', dispatch: async (e) => { seenA.push(e.id); } });
  const wB = worker({ workerId: 'db-wB', dispatch: async (e) => { seenB.push(e.id); } });

  await Promise.all([wA.tick(), wB.tick()]);

  const all = seenA.concat(seenB);
  assert.equal(new Set(all).size, all.length, 'FOR UPDATE SKIP LOCKED must prevent double dispatch');
});

test('W5. expired-lease recovery makes a row claimable again', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const id = await seedOutboxRow(tenantA, {
    status: 'PROCESSING',
    leaseUntil: new Date(Date.now() - 60000),
    leaseOwner: 'crashed-worker'
  });

  const c = await worker().tick();

  assert.ok(c.leasesRecovered >= 1);
  const after = await rowById(tenantA, id);
  assert.equal(after.status, 'COMPLETED', 'recovered, then claimed and completed in the same tick');
});

test('W6. an unexpired lease owned by another worker is never stolen', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const id = await seedOutboxRow(tenantA, {
    status: 'PROCESSING',
    leaseUntil: new Date(Date.now() + 3600000),
    leaseOwner: 'other-worker'
  });

  const seen = [];
  await worker({ dispatch: async (e) => { seen.push(e.id); } }).tick();

  assert.ok(!seen.includes(id), 'the live lease must be respected');
  const after = await rowById(tenantA, id);
  assert.equal(after.status, 'PROCESSING');
  assert.equal(after.lease_owner, 'other-worker');
});

test('W7. the worker never touches another tenant rows', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const idA = await seedOutboxRow(tenantA, { seed: 'iso-a' });
  const idB = await seedOutboxRow(tenantB, { seed: 'iso-b' });

  const seen = [];
  await worker({ dispatch: async (e) => { seen.push({ id: e.id, tenantId: e.tenantId }); } }).tick();

  for (const s of seen) {
    if (s.id === idA) assert.equal(s.tenantId, tenantA.tenantId);
    if (s.id === idB) assert.equal(s.tenantId, tenantB.tenantId);
  }
  const a = await rowById(tenantA, idA);
  const b = await rowById(tenantB, idB);
  assert.equal(a.tenant_id, tenantA.tenantId);
  assert.equal(b.tenant_id, tenantB.tenantId);
});

test('W8. a cross-tenant transition affects zero rows', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const idA = await seedOutboxRow(tenantA, {
    status: 'PROCESSING', leaseUntil: new Date(Date.now() + 3600000), leaseOwner: 'x'
  });

  // Tenant B's context must not be able to complete tenant A's row.
  await ariOutboxWrappers.markCompletedForTenant({ pool, tenantId: tenantB.tenantId, id: idA });

  const after = await rowById(tenantA, idA);
  assert.equal(after.status, 'PROCESSING', 'RLS scoped the UPDATE to zero rows');
});

test('W9. gates OFF claims nothing even with actionable work present', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const id = await seedOutboxRow(tenantA);

  const gated = buildAriOutboxWorker({
    tenantResolver: resolver(),
    outbox: ariOutboxWrappers,
    pool,
    dispatcher: { isReady: () => true, dispatch: async () => {} },
    workerId: 'db-gated',
    config: { isEnabled: () => false, isDispatchEnabled: () => true }
  });
  const c = await gated.tick();

  assert.equal(c.ticksSkipped, 1);
  assert.equal(c.rowsClaimed, 0);
  const after = await rowById(tenantA, id);
  assert.equal(after.status, 'PENDING', 'untouched');
});

test('W10. a not-ready dispatcher claims nothing', async () => {
  await clearOutbox(tenantA);
  await clearOutbox(tenantB);
  const id = await seedOutboxRow(tenantA);

  const c = await worker({ ready: false }).tick();

  assert.equal(c.ticksSkipped, 1);
  const after = await rowById(tenantA, id);
  assert.equal(after.status, 'PENDING');
});

// ---------------------------------------------------------------------------
// S. Security posture is unchanged by everything above
// ---------------------------------------------------------------------------

test('S1. RLS and FORCE RLS remain enabled on ari_outbox_store', async () => {
  const r = await pool.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname='ari_outbox_store'`);
  assert.equal(r.rows[0].relrowsecurity, true);
  assert.equal(r.rows[0].relforcerowsecurity, true);
});

test('S2. the test role remains LOGIN, non-superuser and NOBYPASSRLS', async () => {
  const r = await pool.query(
    "SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  assert.equal(r.rows[0].rolcanlogin, true);
  assert.equal(r.rows[0].rolsuper, false);
  assert.equal(r.rows[0].rolbypassrls, false);
});

test('S3. the current user is qyrvia_test, not postgres', async () => {
  const r = await pool.query('SELECT current_user AS cu, current_database() AS db');
  assert.equal(r.rows[0].cu, 'qyrvia_test');
  assert.equal(r.rows[0].db, 'qyrvia_test');
});

test('S4. the resolver exposes tenant ids and nothing else', async () => {
  const r = await pool.query('SELECT * FROM worker_resolvers.due_ari_outbox_tenants($1)', [1]);
  assert.deepEqual(r.fields.map((f) => f.name), ['tenant_id'],
    'one column only — anything more is cross-tenant data escaping RLS');
});

test('S5. no channel_sync_queue_store row was created by any ARI outbox operation', async () => {
  const r = await H.withTenant(pool, tenantA.tenantId, (c) =>
    c.query('SELECT count(*)::int AS n FROM channel_sync_queue_store WHERE tenant_id=$1',
      [tenantA.tenantId]));
  assert.equal(r.rows[0].n, 0, 'the ARI outbox must stay decoupled from the channel queue');
});

}
