'use strict';

/**
 * Phase 66A-B2H (P0-14) - schedulerRepo.claimDueJobs() against REAL PostgreSQL.
 *
 * STRICT data-level boundary, same as the sibling channel-queue DB test: no
 * DDL, no CREATE ROLE, no DROP SCHEMA, no migration at runtime; single
 * existing role (qyrvia_test); fixtures cleaned up with DELETE.
 * scheduled_jobs is FORCE RLS, so before this phase a bare pool.query claim
 * (with no app.tenant_id bound) silently claimed nothing under this role -
 * that is exactly P0-14. This file proves the fix: tenant discovery through
 * worker_resolvers.due_scheduler_tenants, then per-tenant claiming inside a
 * tenant-bound unit of work, still honours FORCE RLS.
 *
 * Proves:
 *   - tenant isolation : due jobs for two distinct tenants are each claimed
 *                        under their own tenant context; no cross-tenant leak
 *   - not-due exclusion: a future run_at row is never claimed
 *   - concurrency      : FOR UPDATE SKIP LOCKED -> two concurrent claimDueJobs
 *                        calls never claim the same row
 *   - security posture  : after all of the above, role attributes, RLS/FORCE
 *                        RLS, migration 0085's tracking row and its exact
 *                        nine column grants are all unchanged
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
  const { buildRepos } = require('../../src/db/repos');

  let pool, repos, tenantA, tenantB;
  const WORKER_ID = 'phase66a-b2h-test-worker';

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

  async function insertJob(tenant, { runAt, jobType }) {
    const id = crypto.randomUUID();
    // scheduled_jobs has a partial unique index on (tenant_id, job_type) WHERE
    // status IN ('pending','running') (0070_booking_confirmation_delivery.sql).
    // A random suffix keeps every seeded job distinct regardless of test
    // order or what an earlier test in this file left active for the tenant.
    jobType = jobType || ('phase66a_b2h_test_job_' + crypto.randomBytes(4).toString('hex'));
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query(
        `INSERT INTO scheduled_jobs (id, tenant_id, property_id, job_type, run_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, tenant.tenantId, tenant.propertyId, jobType, runAt]
      );
    });
    return id;
  }

  async function fetchJob(tenant, id) {
    return H.withTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query('SELECT * FROM scheduled_jobs WHERE id=$1', [id]);
      return r.rows[0] || null;
    });
  }

  async function cleanupTenant(tenant) {
    if (!tenant) return;
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query('DELETE FROM scheduled_jobs WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM tenants WHERE id=$1', [tenant.tenantId]);
    });
  }

  before(async () => {
    pool = H.newPool(URL);
    // to_regclass is for relations (tables/views); due_scheduler_tenants is a
    // FUNCTION, so its existence is resolved with to_regprocedure instead.
    const reg = await pool.query("SELECT to_regprocedure('worker_resolvers.due_scheduler_tenants(integer)') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: worker_resolvers.due_scheduler_tenants(integer) missing - ' +
      'run the worker-resolver bootstrap and apply migration 0085 before running this test');
    repos = buildRepos(pool);
    tenantA = await seedTenantProperty('B2H-A-' + Date.now().toString(36));
    tenantB = await seedTenantProperty('B2H-B-' + Date.now().toString(36));
  });

  after(async () => {
    if (pool) {
      await cleanupTenant(tenantA);
      await cleanupTenant(tenantB);
      await pool.end();
    }
  });

  test('tenant isolation: due jobs for two distinct tenants are each claimed, correctly attributed, no cross-tenant leak', async () => {
    const dueA = await insertJob(tenantA, { runAt: new Date(Date.now() - 60_000).toISOString() });
    const dueB = await insertJob(tenantB, { runAt: new Date(Date.now() - 60_000).toISOString() });
    const future = await insertJob(tenantA, { runAt: new Date(Date.now() + 3_600_000).toISOString() });

    const claimed = await repos.schedulerRepo.claimDueJobs({ workerId: WORKER_ID, limit: 100 });

    const claimedA = claimed.find((j) => j.id === dueA);
    const claimedB = claimed.find((j) => j.id === dueB);
    assert.ok(claimedA, 'tenant A due job was claimed');
    assert.ok(claimedB, 'tenant B due job was claimed');
    assert.equal(claimedA.tenant_id, tenantA.tenantId, 'tenant A job is attributed to tenant A, not another tenant');
    assert.equal(claimedB.tenant_id, tenantB.tenantId, 'tenant B job is attributed to tenant B, not another tenant');
    assert.equal(claimedA.status, 'running');
    assert.equal(claimedB.status, 'running');
    assert.notEqual(claimedA.tenant_id, claimedB.tenant_id, 'no cross-tenant row was returned under the wrong tenant');

    const untouchedFuture = claimed.find((j) => j.id === future);
    assert.equal(untouchedFuture, undefined, 'the future/not-due job must not appear among claimed rows');

    const futureRow = await fetchJob(tenantA, future);
    assert.equal(futureRow.status, 'pending', 'the future/not-due job remains pending, unclaimed');
    assert.equal(futureRow.locked_by, null, 'the future/not-due job was never locked');
  });

  test('a job with run_at in the future is never returned even when its tenant has other due work', async () => {
    // tenantA already has a claimed (running) job and an untouched future job
    // from the previous test; add one more due job so tenantA is discovered
    // again, and confirm the future row from the previous test is STILL untouched.
    const secondDue = await insertJob(tenantA, { runAt: new Date(Date.now() - 5_000).toISOString() });
    const claimed = await repos.schedulerRepo.claimDueJobs({ workerId: WORKER_ID, limit: 100 });
    const claimedSecond = claimed.find((j) => j.id === secondDue);
    assert.ok(claimedSecond, 'the newly-due tenant A job was claimed');
    assert.equal(claimedSecond.tenant_id, tenantA.tenantId);

    const stillPendingFuture = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int n FROM scheduled_jobs
          WHERE tenant_id=$1 AND status='pending' AND run_at > now()`,
        [tenantA.tenantId]
      );
      return r.rows[0].n;
    });
    assert.ok(stillPendingFuture >= 1, 'at least the original future job remains pending and untouched');
  });

  test('concurrency: two concurrent claimDueJobs calls never claim the same job (SKIP LOCKED)', async () => {
    // Clean slate for this tenant so the "no jobs remain" assertion is deterministic.
    await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query('DELETE FROM scheduled_jobs WHERE tenant_id=$1', [tenantA.tenantId]));

    const j1 = await insertJob(tenantA, { runAt: new Date(Date.now() - 30_000).toISOString(), jobType: 'phase66a_b2h_concurrency_1' });
    const j2 = await insertJob(tenantA, { runAt: new Date(Date.now() - 30_000).toISOString(), jobType: 'phase66a_b2h_concurrency_2' });

    const [r1, r2] = await Promise.all([
      repos.schedulerRepo.claimDueJobs({ workerId: WORKER_ID + '-1', limit: 1 }),
      repos.schedulerRepo.claimDueJobs({ workerId: WORKER_ID + '-2', limit: 1 })
    ]);

    const claimedIds = [...r1.map((j) => j.id), ...r2.map((j) => j.id)].filter((id) => id === j1 || id === j2);
    const uniqueClaimedIds = new Set(claimedIds);
    assert.equal(claimedIds.length, 2, 'both due jobs were claimed exactly once between the two concurrent calls');
    assert.equal(uniqueClaimedIds.size, 2, 'the same job was not claimed twice');

    const remaining = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int n FROM scheduled_jobs
          WHERE tenant_id=$1 AND status='pending' AND id = ANY($2)`,
        [tenantA.tenantId, [j1, j2]]
      );
      return r.rows[0].n;
    });
    assert.equal(remaining, 0, 'no pending rows remain among the two seeded jobs - a concurrent claim did not return an already-claimed row');
  });

  test('database security posture is unchanged after all claiming activity', async () => {
    const r = await pool.query(`SELECT json_build_object(
      'qyrvia_test', (SELECT json_build_object('can_login', rolcanlogin, 'is_superuser', rolsuper, 'bypassrls', rolbypassrls) FROM pg_roles WHERE rolname='qyrvia_test'),
      'qyrvia_auth_resolver', (SELECT json_build_object('can_login', rolcanlogin, 'is_superuser', rolsuper, 'bypassrls', rolbypassrls) FROM pg_roles WHERE rolname='qyrvia_auth_resolver'),
      'runtime_memberships', (SELECT count(*) FROM pg_auth_members m JOIN pg_roles x ON x.oid=m.member WHERE x.rolname='qyrvia_test'),
      'scheduled_jobs_owner', (SELECT pg_get_userbyid(relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='scheduled_jobs'),
      'rls_enabled', (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='scheduled_jobs'),
      'force_rls', (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='scheduled_jobs'),
      'migration_0085_count', (SELECT count(*)::int FROM schema_migrations WHERE version='0085_worker_resolver_source_column_grants'),
      'applied_versions', (SELECT coalesce(json_agg(version), '[]'::json) FROM schema_migrations),
      'queue_columns', (SELECT coalesce(json_agg(column_name ORDER BY column_name),'[]'::json) FROM information_schema.column_privileges WHERE grantee='qyrvia_auth_resolver' AND table_schema='public' AND table_name='channel_sync_queue_store' AND privilege_type='SELECT'),
      'jobs_columns', (SELECT coalesce(json_agg(column_name ORDER BY column_name),'[]'::json) FROM information_schema.column_privileges WHERE grantee='qyrvia_auth_resolver' AND table_schema='public' AND table_name='scheduled_jobs' AND privilege_type='SELECT'),
      'table_wide_select', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a WHERE n.nspname='public' AND c.relname IN ('channel_sync_queue_store','scheduled_jobs') AND pg_get_userbyid(a.grantee)='qyrvia_auth_resolver' AND a.privilege_type='SELECT')
    ) AS doc`);
    const doc = r.rows[0].doc;

    assert.equal(doc.qyrvia_test.can_login, true);
    assert.equal(doc.qyrvia_test.is_superuser, false);
    assert.equal(doc.qyrvia_test.bypassrls, false);
    assert.equal(doc.qyrvia_auth_resolver.can_login, false);
    assert.equal(doc.qyrvia_auth_resolver.is_superuser, false);
    assert.equal(doc.qyrvia_auth_resolver.bypassrls, true);
    assert.equal(doc.runtime_memberships, 0, 'qyrvia_test gained no privileged role membership');
    assert.equal(doc.scheduled_jobs_owner, 'qyrvia_test');
    assert.equal(doc.rls_enabled, true);
    assert.equal(doc.force_rls, true);
    assert.equal(doc.migration_0085_count, 1, 'migration 0085 is recorded exactly once - not reapplied, not missing');
    assert.deepEqual(doc.queue_columns, ['max_retries', 'next_retry_at', 'next_run_at', 'retry_count', 'status', 'tenant_id']);
    assert.deepEqual(doc.jobs_columns, ['run_at', 'status', 'tenant_id']);
    assert.equal(doc.table_wide_select, 0, 'no table-wide SELECT exists for qyrvia_auth_resolver');

    const migrationsDir = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
    const diskVersions = fs.readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => f.replace(/\.sql$/, ''));
    const appliedSet = new Set(doc.applied_versions);
    const pending = diskVersions.filter((v) => !appliedSet.has(v));
    assert.deepEqual(pending, [], 'no migration is pending - every file on disk is recorded as applied');
  });
}
