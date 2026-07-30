'use strict';

/**
 * Phase 66A-B2I (P0-12 queue-claiming prerequisite) -
 * dequeuePendingAcrossTenants() against REAL PostgreSQL.
 *
 * STRICT data-level boundary, same as the sibling scheduler DB test and
 * channel_queue_persistence.db.test.js: no DDL, no CREATE ROLE, no DROP
 * SCHEMA, no migration at runtime; single existing role (qyrvia_test);
 * fixtures cleaned up with DELETE. channel_sync_queue_store is FORCE RLS, so
 * before this phase a bare pool.query dequeue (with no app.tenant_id bound)
 * silently claimed nothing under this role - that is the P0-12 discovery
 * defect. This file proves the fix: tenant discovery through
 * worker_resolvers.pending_channel_tenants, then per-tenant claiming inside
 * a tenant-bound unit of work, still honours FORCE RLS, and that the
 * claim query correctly excludes backing-off/exhausted/non-pending rows.
 *
 * Proves:
 *   - tenant isolation   : eligible rows for two distinct tenants are each
 *                          claimed under their own tenant context; no leak
 *   - due-time filtering : future next_retry_at / next_run_at rows,
 *                          retry-exhausted rows, and non-pending rows are
 *                          never claimed
 *   - concurrency        : FOR UPDATE SKIP LOCKED -> two concurrent claim
 *                          attempts on the same tenant never claim the same
 *                          row twice
 *   - security posture   : after all of the above, role attributes, RLS/
 *                          FORCE RLS, migration 0085's tracking row and its
 *                          exact grants (both queue and scheduler columns)
 *                          are all unchanged
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  const { dequeuePendingAcrossTenants } = require('../../src/channel-manager/persistence/dbStores');

  let pool, tenantA, tenantB;

  async function seedTenantProperty(code) {
    const tenantId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    await H.withTenant(pool, tenantId, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tenantId, code, code]);
      await c.query(
        'INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)',
        [propertyId, tenantId, code, code, 'LKR']
      );
    });
    return { tenantId, propertyId };
  }

  /** Raw insert, bypassing enqueue() so next_retry_at/next_run_at/retry_count/max_retries/status can be set directly. */
  async function insertRow(tenant, {
    reservationId, action = 'CREATE_BOOKING', status = 'PENDING',
    nextRetryAt = null, nextRunAt = null, retryCount = 0, maxRetries = 4
  }) {
    const id = crypto.randomUUID();
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query(
        `INSERT INTO channel_sync_queue_store
           (id, tenant_id, property_id, reservation_id, action, status,
            next_retry_at, next_run_at, retry_count, max_retries)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, tenant.tenantId, tenant.propertyId, reservationId, action, status,
         nextRetryAt, nextRunAt, retryCount, maxRetries]
      );
    });
    return id;
  }

  async function fetchRow(tenant, id) {
    return H.withTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query('SELECT * FROM channel_sync_queue_store WHERE id=$1', [id]);
      return r.rows[0] || null;
    });
  }

  async function cleanupTenant(tenant) {
    if (!tenant) return;
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query('DELETE FROM channel_sync_queue_store WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM tenants WHERE id=$1', [tenant.tenantId]);
    });
  }

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regprocedure('worker_resolvers.pending_channel_tenants(integer)') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: worker_resolvers.pending_channel_tenants(integer) missing - ' +
      'run the worker-resolver bootstrap and apply migration 0085 before running this test');
    tenantA = await seedTenantProperty('B2I-A-' + Date.now().toString(36));
    tenantB = await seedTenantProperty('B2I-B-' + Date.now().toString(36));
  });

  after(async () => {
    if (pool) {
      await cleanupTenant(tenantA);
      await cleanupTenant(tenantB);
      await pool.end();
    }
  });

  test('tenant isolation: eligible rows for two distinct tenants are each claimed, correctly attributed, no cross-tenant leak', async () => {
    const dueA = await insertRow(tenantA, { reservationId: 'R-A-' + crypto.randomBytes(3).toString('hex') });
    const dueB = await insertRow(tenantB, { reservationId: 'R-B-' + crypto.randomBytes(3).toString('hex') });

    const claimed = await dequeuePendingAcrossTenants({ pool, limit: 100 });

    const claimedA = claimed.find((row) => row.id === dueA);
    const claimedB = claimed.find((row) => row.id === dueB);
    assert.ok(claimedA, 'tenant A eligible row was claimed');
    assert.ok(claimedB, 'tenant B eligible row was claimed');
    assert.equal(claimedA.tenant_id, tenantA.tenantId, 'tenant A row is attributed to tenant A, not another tenant');
    assert.equal(claimedB.tenant_id, tenantB.tenantId, 'tenant B row is attributed to tenant B, not another tenant');
    assert.equal(claimedA.status, 'PROCESSING');
    assert.equal(claimedB.status, 'PROCESSING');
    assert.notEqual(claimedA.tenant_id, claimedB.tenant_id, 'no cross-tenant row was returned under the wrong tenant');
  });

  test('due-time filtering: a future next_retry_at row is never claimed', async () => {
    const future = await insertRow(tenantA, {
      reservationId: 'R-A-FUTURE-RETRY-' + crypto.randomBytes(3).toString('hex'),
      nextRetryAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    const claimed = await dequeuePendingAcrossTenants({ pool, limit: 100 });
    assert.equal(claimed.find((row) => row.id === future), undefined, 'future next_retry_at row must not be claimed');
    const row = await fetchRow(tenantA, future);
    assert.equal(row.status, 'PENDING', 'the row remains pending, unclaimed');
  });

  test('due-time filtering: a future next_run_at row is never claimed', async () => {
    const future = await insertRow(tenantA, {
      reservationId: 'R-A-FUTURE-RUN-' + crypto.randomBytes(3).toString('hex'),
      nextRunAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    const claimed = await dequeuePendingAcrossTenants({ pool, limit: 100 });
    assert.equal(claimed.find((row) => row.id === future), undefined, 'future next_run_at row must not be claimed');
    const row = await fetchRow(tenantA, future);
    assert.equal(row.status, 'PENDING');
  });

  test('max_retries exclusion: a row whose retry_count has reached max_retries is never claimed', async () => {
    const exhausted = await insertRow(tenantA, {
      reservationId: 'R-A-EXHAUSTED-' + crypto.randomBytes(3).toString('hex'),
      retryCount: 4, maxRetries: 4
    });
    const claimed = await dequeuePendingAcrossTenants({ pool, limit: 100 });
    assert.equal(claimed.find((row) => row.id === exhausted), undefined, 'retry-exhausted row must not be claimed');
    const row = await fetchRow(tenantA, exhausted);
    assert.equal(row.status, 'PENDING', 'exhausted work is not silently returned as normal pending work');
  });

  test('non-pending exclusion: a PROCESSING/COMPLETED/FAILED row is never (re-)claimed', async () => {
    const processing = await insertRow(tenantA, { reservationId: 'R-A-PROC-' + crypto.randomBytes(3).toString('hex'), status: 'PROCESSING' });
    const completed = await insertRow(tenantA, { reservationId: 'R-A-DONE-' + crypto.randomBytes(3).toString('hex'), status: 'COMPLETED' });
    const failed = await insertRow(tenantA, { reservationId: 'R-A-FAIL-' + crypto.randomBytes(3).toString('hex'), status: 'FAILED' });

    const claimed = await dequeuePendingAcrossTenants({ pool, limit: 100 });
    for (const id of [processing, completed, failed]) {
      assert.equal(claimed.find((row) => row.id === id), undefined, 'a non-pending row must never be (re-)claimed');
    }
  });

  test('concurrency: two concurrent claim attempts never claim the same row (SKIP LOCKED)', async () => {
    // Clean slate for tenant A so the "no eligible rows remain" assertion is deterministic.
    await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query('DELETE FROM channel_sync_queue_store WHERE tenant_id=$1', [tenantA.tenantId]));

    const r1 = await insertRow(tenantA, { reservationId: 'R-A-CONC-1-' + crypto.randomBytes(3).toString('hex') });
    const r2 = await insertRow(tenantA, { reservationId: 'R-A-CONC-2-' + crypto.randomBytes(3).toString('hex') });

    const [c1, c2] = await Promise.all([
      dequeuePendingAcrossTenants({ pool, limit: 100 }),
      dequeuePendingAcrossTenants({ pool, limit: 100 })
    ]);

    const claimedIds = [...c1.map((row) => row.id), ...c2.map((row) => row.id)].filter((id) => id === r1 || id === r2);
    const uniqueClaimedIds = new Set(claimedIds);
    assert.equal(claimedIds.length, 2, 'both eligible rows were claimed exactly once between the two concurrent calls');
    assert.equal(uniqueClaimedIds.size, 2, 'the same row was not claimed twice');

    const remaining = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int n FROM channel_sync_queue_store
          WHERE tenant_id=$1 AND status='PENDING' AND id = ANY($2)`,
        [tenantA.tenantId, [r1, r2]]
      );
      return r.rows[0].n;
    });
    assert.equal(remaining, 0, 'no pending rows remain among the two seeded rows - a concurrent claim did not return an already-claimed row');
  });

  test('database security posture is unchanged after all claiming activity', async () => {
    const r = await pool.query(`SELECT json_build_object(
      'qyrvia_test', (SELECT json_build_object('can_login', rolcanlogin, 'is_superuser', rolsuper, 'bypassrls', rolbypassrls) FROM pg_roles WHERE rolname='qyrvia_test'),
      'qyrvia_auth_resolver', (SELECT json_build_object('can_login', rolcanlogin, 'is_superuser', rolsuper, 'bypassrls', rolbypassrls) FROM pg_roles WHERE rolname='qyrvia_auth_resolver'),
      'runtime_memberships', (SELECT count(*) FROM pg_auth_members m JOIN pg_roles x ON x.oid=m.member WHERE x.rolname='qyrvia_test'),
      'queue_owner', (SELECT pg_get_userbyid(relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='channel_sync_queue_store'),
      'queue_rls', (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='channel_sync_queue_store'),
      'queue_force_rls', (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='channel_sync_queue_store'),
      'migration_0085_count', (SELECT count(*)::int FROM schema_migrations WHERE version='0085_worker_resolver_source_column_grants'),
      'applied_versions', (SELECT coalesce(json_agg(version), '[]'::json) FROM schema_migrations),
      'queue_columns', (SELECT coalesce(json_agg(column_name ORDER BY column_name),'[]'::json) FROM information_schema.column_privileges WHERE grantee='qyrvia_auth_resolver' AND table_schema='public' AND table_name='channel_sync_queue_store' AND privilege_type='SELECT'),
      'scheduler_columns', (SELECT coalesce(json_agg(column_name ORDER BY column_name),'[]'::json) FROM information_schema.column_privileges WHERE grantee='qyrvia_auth_resolver' AND table_schema='public' AND table_name='scheduled_jobs' AND privilege_type='SELECT'),
      'table_wide_select', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a WHERE n.nspname='public' AND c.relname IN ('channel_sync_queue_store','scheduled_jobs') AND pg_get_userbyid(a.grantee)='qyrvia_auth_resolver' AND a.privilege_type='SELECT'),
      'public_table_priv', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a WHERE n.nspname='public' AND c.relname IN ('channel_sync_queue_store','scheduled_jobs') AND a.grantee=0),
      'public_column_priv', (SELECT count(*) FROM information_schema.column_privileges WHERE grantee='PUBLIC' AND table_schema='public' AND table_name IN ('channel_sync_queue_store','scheduled_jobs'))
    ) AS doc`);
    const doc = r.rows[0].doc;

    assert.equal(doc.qyrvia_test.can_login, true);
    assert.equal(doc.qyrvia_test.is_superuser, false);
    assert.equal(doc.qyrvia_test.bypassrls, false);
    assert.equal(doc.qyrvia_auth_resolver.can_login, false);
    assert.equal(doc.qyrvia_auth_resolver.is_superuser, false);
    assert.equal(doc.qyrvia_auth_resolver.bypassrls, true);
    assert.equal(doc.runtime_memberships, 0, 'qyrvia_test gained no privileged role membership');
    assert.equal(doc.queue_owner, 'qyrvia_test');
    assert.equal(doc.queue_rls, true);
    assert.equal(doc.queue_force_rls, true);
    assert.equal(doc.migration_0085_count, 1, 'migration 0085 is recorded exactly once - not reapplied, not missing');
    assert.deepEqual(doc.queue_columns, ['max_retries', 'next_retry_at', 'next_run_at', 'retry_count', 'status', 'tenant_id']);
    assert.deepEqual(doc.scheduler_columns, ['run_at', 'status', 'tenant_id']);
    assert.equal(doc.table_wide_select, 0, 'no table-wide SELECT exists for qyrvia_auth_resolver on either table');
    assert.equal(doc.public_table_priv, 0, 'PUBLIC holds no table-level privilege on either table');
    assert.equal(doc.public_column_priv, 0, 'PUBLIC holds no column-level privilege on either table');

    const migrationsDir = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
    const diskVersions = fs.readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => f.replace(/\.sql$/, ''));
    const appliedSet = new Set(doc.applied_versions);
    const pending = diskVersions.filter((v) => !appliedSet.has(v));
    assert.deepEqual(pending, [], 'no migration is pending - every file on disk is recorded as applied');
  });
}
