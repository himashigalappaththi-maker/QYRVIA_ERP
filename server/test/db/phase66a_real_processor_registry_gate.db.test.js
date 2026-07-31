'use strict';

/**
 * Phase 66A-B2L (P0-12 real-processor prerequisite) - the real channel
 * processor, gated by all three independent switches (worker lifecycle,
 * master dispatch, real-mode selection) plus live per-channel registry
 * authorization, through the REAL production worker code path against REAL
 * PostgreSQL.
 *
 * STRICT data-level boundary, same as every sibling B2H/B2I/B2J/B2K DB test:
 * no DDL, no CREATE ROLE, no DROP SCHEMA, no migration at runtime; single
 * existing role (qyrvia_test); fixtures cleaned up with DELETE.
 *
 * Zero external network activity anywhere in this file: the channel registry
 * and the QYRVIA Connect transport are both fake, injected dependencies
 * (per this phase's own instructions) — buildRealProcessor's default
 * disabled-HTTP path for external OTAs is never exercised here at all; only
 * the QYRVIA_CONNECT/in-process branch is used, with a fake qtcnTransport
 * spy standing in for the loopback sink.
 *
 * Proves:
 *   - the B2K master dispatch guard still blocks every claim before dequeue,
 *     regardless of which processor would have been used;
 *   - the existing mock cycle is unaffected by this phase, and the fake
 *     "real" adapter is never touched while mock mode is selected;
 *   - a disabled/absent registry record denies dispatch: zero adapter calls,
 *     the row is never completed, and it reaches the same terminal FAILED
 *     state as any other processor failure (the one safe existing
 *     transition established at discovery — no new state was invented);
 *   - an enabled registry record authorizes exactly one adapter call and the
 *     row reaches COMPLETED, correctly attributed to its own tenant/channel;
 *   - a second, empty tick does not redispatch;
 *   - registry authorization is re-evaluated per job — disabling the
 *     registry between two claimed rows blocks only the second;
 *   - a genuine adapter failure (registry-authorized) still reaches FAILED,
 *     distinct in cause from a registry denial;
 *   - the database security posture is unchanged after all of the above.
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
  const { buildRealProcessor } = require('../../src/channel-manager/worker/realProcessor');
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

  async function insertRow(tenant, { reservationId, action = 'CREATE_BOOKING', channel = 'QYRVIA_CONNECT' }) {
    const id = crypto.randomUUID();
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query(
        `INSERT INTO channel_sync_queue_store (id, tenant_id, property_id, reservation_id, action, channel, status)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING')`,
        [id, tenant.tenantId, tenant.propertyId, reservationId, action, channel]
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
      markFailed:    (tenantId, id) => dbm.markQueueFailedForTenant({ pool, tenantId, id })
    };
  }

  function makeSecretProvider() { return { async get() { return null; } }; }

  /** Fake channel registry: enabledMap is a mutable { [tenantId]: { [channel]: bool } } map. */
  function makeFakeRegistry(enabledMap) {
    const calls = [];
    return {
      calls,
      async get(channel, { tenantId }) {
        calls.push({ channel, tenantId });
        const forTenant = enabledMap[tenantId];
        if (!forTenant || forTenant[channel] === undefined) return null;
        return { enabled: forTenant[channel] };
      }
    };
  }

  /** Fake QYRVIA Connect transport spy — no socket, no DNS, records calls only. */
  function makeFakeQtcnTransport(resultFn) {
    const calls = [];
    return {
      calls,
      async send(req) {
        calls.push(req);
        return typeof resultFn === 'function' ? resultFn(req) : { ok: true, status: 200, ackId: 'fake-ack' };
      }
    };
  }

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regprocedure('worker_resolvers.pending_channel_tenants(integer)') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: worker_resolvers.pending_channel_tenants(integer) missing - ' +
      'run the worker-resolver bootstrap and apply migration 0085 before running this test');
    tenantA = await seedTenantProperty('B2L-A-' + Date.now().toString(36));
    tenantB = await seedTenantProperty('B2L-B-' + Date.now().toString(36));
  });

  after(async () => {
    if (pool) {
      await cleanupTenant(tenantA);
      await cleanupTenant(tenantB);
      await pool.end();
    }
  });

  // ---------------------------------------------------------------------
  // 1. MASTER GATE: dispatch disabled blocks everything, regardless of
  //    which processor would have been used.
  // ---------------------------------------------------------------------
  test('master dispatch switch false: zero claim and zero adapter call, even with a real, fully-authorized fake registry wired', async () => {
    const id = await insertRow(tenantA, { reservationId: 'R-GATE-' + crypto.randomBytes(3).toString('hex') });
    const registry = makeFakeRegistry({ [tenantA.tenantId]: { QYRVIA_CONNECT: true } });
    const qtcn = makeFakeQtcnTransport();
    const processor = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: qtcn });

    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => false, enabled: false });
    const result = await worker.tick();

    assert.equal(result.disabled, true);
    assert.equal(result.reason, 'dispatch_disabled');
    assert.deepEqual(result.results, []);
    assert.equal(qtcn.calls.length, 0);
    assert.equal(registry.calls.length, 0, 'the processor is never even invoked while dispatch is disabled');

    const row = await fetchRow(tenantA, id);
    assert.equal(row.status, 'PENDING', 'the row must remain untouched while dispatch is disabled');

    // Fixture hygiene, not a production concern: this row was deliberately
    // left PENDING to prove the master gate blocks it. dequeue() claims the
    // OLDEST PENDING row per tenant (FIFO), so leaving it in place would
    // make every later test in this file claim it instead of its own
    // freshly-inserted row. Remove it directly so tenantA starts clean for
    // the next test.
    await H.withTenant(pool, tenantA.tenantId, (c) => c.query('DELETE FROM channel_sync_queue_store WHERE id=$1', [id]));
  });

  // ---------------------------------------------------------------------
  // 2. MOCK MODE: master true, real processor not selected — unaffected by
  //    this phase; the fake "real" adapter must never be touched.
  // ---------------------------------------------------------------------
  test('master dispatch true, mock mode: the existing mock cycle still works and the fake real adapter is never called', async () => {
    const id = await insertRow(tenantA, { reservationId: 'R-MOCK-' + crypto.randomBytes(3).toString('hex') });
    const qtcn = makeFakeQtcnTransport();

    const worker = buildChannelQueueWorker({
      queue: buildDbWorkerQueueAdapter(),
      processor: buildMockProcessor({ shouldFail: () => false }),
      isDispatchEnabled: () => true,
      enabled: false
    });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'COMPLETED');
    assert.equal(qtcn.calls.length, 0, 'the fake real transport was never constructed into this worker, let alone called');

    const row = await fetchRow(tenantA, id);
    assert.equal(row.status, 'COMPLETED');
  });

  // ---------------------------------------------------------------------
  // 3. REAL MODE — REGISTRY DISABLED
  // ---------------------------------------------------------------------
  test('master dispatch true, real mode, registry disabled: zero adapter calls, row never completed, safe FAILED outcome', async () => {
    const id = await insertRow(tenantA, { reservationId: 'R-DENY-' + crypto.randomBytes(3).toString('hex') });
    const registry = makeFakeRegistry({ [tenantA.tenantId]: { QYRVIA_CONNECT: false } });
    const qtcn = makeFakeQtcnTransport();
    const processor = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: qtcn });

    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed, 'the row was claimed (dispatch was enabled) but the processor denied it');
    assert.equal(claimed.status, 'FAILED');
    assert.equal(claimed.skipped, true);
    assert.equal(qtcn.calls.length, 0, 'no external call for a registry-denied channel');

    const row = await fetchRow(tenantA, id);
    assert.equal(row.status, 'FAILED');
    assert.notEqual(row.status, 'COMPLETED', 'registry-denied work must never be marked completed');
  });

  // ---------------------------------------------------------------------
  // 4. REAL MODE — REGISTRY ENABLED
  // ---------------------------------------------------------------------
  test('master dispatch true, real mode, registry enabled: exactly one adapter call, row reaches COMPLETED, correct tenant/channel attribution', async () => {
    const id = await insertRow(tenantB, { reservationId: 'R-ALLOW-' + crypto.randomBytes(3).toString('hex') });
    const registry = makeFakeRegistry({ [tenantB.tenantId]: { QYRVIA_CONNECT: true } });
    const qtcn = makeFakeQtcnTransport(() => ({ ok: true, status: 200, ackId: 'fake-ack-allow' }));
    const processor = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: qtcn });

    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'COMPLETED');
    assert.equal(qtcn.calls.length, 1, 'exactly one adapter call for the one authorized row');

    const row = await fetchRow(tenantB, id);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.tenant_id, tenantB.tenantId);
    assert.equal(row.channel, 'QYRVIA_CONNECT');

    // Empty second tick must not redispatch.
    const emptyQtcn = makeFakeQtcnTransport();
    const processor2 = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: emptyQtcn });
    const worker2 = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor: processor2, isDispatchEnabled: () => true, enabled: false });
    const result2 = await worker2.tick();
    assert.equal(result2.idle, true, 'nothing PENDING remains for tenant B - the row above already completed');
    assert.equal(emptyQtcn.calls.length, 0);
  });

  // ---------------------------------------------------------------------
  // 5. REGISTRY RE-EVALUATION ACROSS TWO ROWS
  // ---------------------------------------------------------------------
  test('registry re-evaluation: authorizing the first row then disabling before the second blocks only the second, with no cross-channel leak', async () => {
    const idFirst  = await insertRow(tenantA, { reservationId: 'R-REEVAL-1-' + crypto.randomBytes(3).toString('hex') });
    const idSecond = await insertRow(tenantB, { reservationId: 'R-REEVAL-2-' + crypto.randomBytes(3).toString('hex') });

    const enabledMap = {
      [tenantA.tenantId]: { QYRVIA_CONNECT: true },
      [tenantB.tenantId]: { QYRVIA_CONNECT: true }
    };
    const qtcn = makeFakeQtcnTransport();
    const registry = {
      calls: [],
      async get(channel, { tenantId }) {
        this.calls.push({ channel, tenantId });
        // Flip tenant B to disabled the instant tenant A's row has been
        // authorized once — proves per-job re-evaluation, not a cached
        // construction-time decision.
        if (tenantId === tenantA.tenantId) return { enabled: enabledMap[tenantId][channel] };
        enabledMap[tenantB.tenantId].QYRVIA_CONNECT = false;
        return { enabled: enabledMap[tenantId][channel] };
      }
    };
    const processor = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: qtcn });
    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimedFirst  = result.results.find((r) => r.id === idFirst);
    const claimedSecond = result.results.find((r) => r.id === idSecond);
    assert.ok(claimedFirst && claimedSecond, 'both rows (one per tenant) were claimed this tick');
    assert.equal(claimedFirst.status, 'COMPLETED', 'tenant A dispatched before the registry flipped');
    assert.equal(claimedSecond.status, 'FAILED');
    assert.equal(claimedSecond.skipped, true, 'tenant B was denied by the same-tick registry flip');
    assert.equal(qtcn.calls.length, 1, 'only the authorized row ever reached the transport');

    const rowA = await fetchRow(tenantA, idFirst);
    const rowB = await fetchRow(tenantB, idSecond);
    assert.equal(rowA.status, 'COMPLETED');
    assert.equal(rowB.status, 'FAILED');
  });

  // ---------------------------------------------------------------------
  // 6. GENUINE ADAPTER FAILURE (registry-authorized) — distinct from denial
  // ---------------------------------------------------------------------
  test('registry-authorized row with a genuine adapter failure reaches FAILED, distinct from a registry denial', async () => {
    const id = await insertRow(tenantA, { reservationId: 'R-ADAPTERFAIL-' + crypto.randomBytes(3).toString('hex') });
    const registry = makeFakeRegistry({ [tenantA.tenantId]: { QYRVIA_CONNECT: true } });
    const qtcn = makeFakeQtcnTransport(() => ({ ok: false, error: 'fake_upstream_error' }));
    const processor = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: qtcn });

    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'FAILED');
    assert.equal(claimed.skipped, undefined, 'a genuine adapter failure must not carry the registry-denial skipped flag');
    assert.equal(qtcn.calls.length, 1, 'the adapter WAS called - it just failed');

    const row = await fetchRow(tenantA, id);
    assert.equal(row.status, 'FAILED');
  });

  // ---------------------------------------------------------------------
  // 7. POST-TEST SECURITY POSTURE
  // ---------------------------------------------------------------------
  test('database security posture is unchanged after the disabled, mock, registry-denied, registry-enabled, re-evaluation and adapter-failure cycles', async () => {
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
