'use strict';

/**
 * Phase 66A-B2J (P0-12 worker-plumbing prerequisite) - a complete mock
 * worker cycle through the REAL production worker code path, against REAL
 * PostgreSQL.
 *
 * STRICT data-level boundary, same as the sibling B2H/B2I DB tests: no DDL,
 * no CREATE ROLE, no DROP SCHEMA, no migration at runtime; single existing
 * role (qyrvia_test); fixtures cleaned up with DELETE. No network request
 * of any kind is made anywhere in this file - the only processor used is
 * buildMockProcessor(), which has no transport capability at all.
 *
 * Proves:
 *   - the repaired worker (buildChannelQueueWorker + the real
 *     dequeuePendingAcrossTenants/markQueueCompletedForTenant adapter,
 *     exactly as wired at boot) claims eligible rows for two distinct
 *     tenants in one tick, correctly attributed, no cross-tenant leak;
 *   - the mock processor is actually invoked for each claimed row;
 *   - a successful mock outcome reaches the persistent COMPLETED state;
 *   - a second, empty tick does not reprocess already-completed rows;
 *   - an injected mock-processor failure (Phase 66A-B2M: retryable by
 *     default, budget remaining) schedules a durable retry — status
 *     returns to PENDING with a future next_retry_at, retry_count
 *     incremented exactly once — and is never marked completed;
 *   - the database security posture (roles, RLS/FORCE RLS, migration 0085's
 *     grants) is unchanged after all of the above.
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
  const dbm = require('../../src/channel-manager/persistence/dbStores');
  const { buildMockProcessor } = require('../../src/channel-manager/worker/mockProcessor');
  const { buildChannelQueueWorker } = require('../../src/channel-manager/worker/channelQueueWorker');

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

  async function insertRow(tenant, { reservationId, action = 'CREATE_BOOKING' }) {
    const id = crypto.randomUUID();
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query(
        `INSERT INTO channel_sync_queue_store (id, tenant_id, property_id, reservation_id, action, status)
         VALUES ($1,$2,$3,$4,$5,'PENDING')`,
        [id, tenant.tenantId, tenant.propertyId, reservationId, action]
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

  /** The exact adapter shape src/index.js builds in db-persistence mode. */
  function buildDbWorkerQueueAdapter() {
    return {
      dequeuePendingAcrossTenants: ({ limit } = {}) => dbm.dequeuePendingAcrossTenants({ pool, limit }),
      markCompleted: (tenantId, id) => dbm.markQueueCompletedForTenant({ pool, tenantId, id }),
      // Phase 66A-B2M: markRetryScheduled/markDeadLetter replace markFailed
      // as the required contract.
      markRetryScheduled: (tenantId, id, nextRetryAt) => dbm.markQueueRetryScheduledForTenant({ pool, tenantId, id, nextRetryAt }),
      markDeadLetter:     (tenantId, id) => dbm.markQueueDeadLetterForTenant({ pool, tenantId, id })
    };
  }

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regprocedure('worker_resolvers.pending_channel_tenants(integer)') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: worker_resolvers.pending_channel_tenants(integer) missing - ' +
      'run the worker-resolver bootstrap and apply migration 0085 before running this test');
    tenantA = await seedTenantProperty('B2J-A-' + Date.now().toString(36));
    tenantB = await seedTenantProperty('B2J-B-' + Date.now().toString(36));
  });

  after(async () => {
    if (pool) {
      await cleanupTenant(tenantA);
      await cleanupTenant(tenantB);
      await pool.end();
    }
  });

  test('a full mock worker cycle claims, processes and completes eligible rows for two tenants, tenant-isolated', async () => {
    const idA = await insertRow(tenantA, { reservationId: 'R-A-' + crypto.randomBytes(3).toString('hex') });
    const idB = await insertRow(tenantB, { reservationId: 'R-B-' + crypto.randomBytes(3).toString('hex') });

    const seenByProcessor = [];
    const processorInner = buildMockProcessor({ shouldFail: () => false });
    const processor = { async process(job) { seenByProcessor.push(job.id); return processorInner.process(job); } };

    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    assert.equal(result.idle, false);
    assert.ok(seenByProcessor.includes(idA), 'the mock processor was invoked for tenant A\'s row');
    assert.ok(seenByProcessor.includes(idB), 'the mock processor was invoked for tenant B\'s row');

    const claimedA = result.results.find((r) => r.id === idA);
    const claimedB = result.results.find((r) => r.id === idB);
    assert.equal(claimedA.status, 'COMPLETED');
    assert.equal(claimedB.status, 'COMPLETED');

    const rowA = await fetchRow(tenantA, idA);
    const rowB = await fetchRow(tenantB, idB);
    assert.equal(rowA.status, 'COMPLETED');
    assert.equal(rowA.tenant_id, tenantA.tenantId, 'tenant A\'s row is attributed to tenant A, not another tenant');
    assert.equal(rowB.status, 'COMPLETED');
    assert.equal(rowB.tenant_id, tenantB.tenantId, 'tenant B\'s row is attributed to tenant B, not another tenant');
  });

  test('a second, empty tick does not reprocess already-completed rows', async () => {
    let processCalls = 0;
    const processor = { async process() { processCalls += 1; return { ok: true }; } };
    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });

    const result = await worker.tick();
    assert.equal(result.idle, true, 'nothing is PENDING any more - the previous test already completed both rows');
    assert.equal(processCalls, 0, 'the mock processor must not be called when nothing is claimed');
  });

  test('an injected mock-processor failure (Phase 66A-B2M: retryable by default, budget remaining) schedules a durable retry and is never marked completed', async () => {
    const failId = await insertRow(tenantA, { reservationId: 'R-A-FAIL-' + crypto.randomBytes(3).toString('hex') });

    const processor = buildMockProcessor({ shouldFail: (job) => job.reservation_id.startsWith('R-A-FAIL-') });
    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === failId);
    assert.ok(claimed, 'the row was claimed and processed');
    assert.equal(claimed.status, 'PENDING');
    assert.equal(claimed.retryScheduled, true);

    const row = await fetchRow(tenantA, failId);
    assert.equal(row.status, 'PENDING', 'the row returned to PENDING with a future next_retry_at (see migration 0086 header)');
    assert.equal(row.retry_count, 1, 'retry_count incremented exactly once');
    assert.ok(row.next_retry_at instanceof Date && row.next_retry_at.getTime() > Date.now(), 'next_retry_at is set in the future');
    assert.notEqual(row.status, 'COMPLETED', 'a failed mock outcome must never be marked completed');
    assert.notEqual(row.status, 'DEAD_LETTER', 'a fresh row (retry_count=0) with budget remaining must not be dead-lettered');
  });

  test('database security posture is unchanged after a full mock worker cycle', async () => {
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
    assert.equal(doc.runtime_memberships, 0);
    assert.equal(doc.queue_owner, 'qyrvia_test');
    assert.equal(doc.queue_rls, true);
    assert.equal(doc.queue_force_rls, true);
    assert.equal(doc.migration_0085_count, 1);
    assert.deepEqual(doc.queue_columns, ['max_retries', 'next_retry_at', 'next_run_at', 'retry_count', 'status', 'tenant_id']);
    assert.deepEqual(doc.scheduler_columns, ['run_at', 'status', 'tenant_id']);
    assert.equal(doc.table_wide_select, 0);
    assert.equal(doc.public_table_priv, 0);
    assert.equal(doc.public_column_priv, 0);

    const migrationsDir = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
    const diskVersions = fs.readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => f.replace(/\.sql$/, ''));
    const appliedSet = new Set(doc.applied_versions);
    const pending = diskVersions.filter((v) => !appliedSet.has(v));
    assert.deepEqual(pending, [], 'no migration is pending');
  });
}
