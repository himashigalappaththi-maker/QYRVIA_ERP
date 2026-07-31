'use strict';

/**
 * Phase 66A-B2M (P0-12 retry/dead-letter prerequisite) - durable reservation-
 * action queue retry, capped backoff and dead-letter handling, through the
 * REAL production worker/persistence code path against REAL PostgreSQL,
 * after migration 0086 has been applied.
 *
 * STRICT data-level boundary, same as every sibling B2H-B2L DB test: no DDL,
 * no CREATE ROLE, no DROP SCHEMA, no migration run inside this file (0086 is
 * applied once, separately, through the normal migration runner before this
 * suite runs); single existing role (qyrvia_test); fixtures cleaned up with
 * DELETE. Zero live network activity: only buildMockProcessor() and
 * buildRealProcessor() with fake channelRegistry/qtcnTransport are used.
 *
 * "Due retry is claimed" (scenario C) and "registry re-enabled" (scenario F)
 * cannot mock PostgreSQL's own now(); both instead set next_retry_at directly
 * to a past timestamp via an approved data-level UPDATE fixture, then tick —
 * exactly the "set fixture time using approved data-level methods" this
 * phase's own instructions call for.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  const dbm = require('../../src/channel-manager/persistence/dbStores');
  const { buildMockProcessor } = require('../../src/channel-manager/worker/mockProcessor');
  const { buildRealProcessor } = require('../../src/channel-manager/worker/realProcessor');
  const { buildChannelQueueWorker } = require('../../src/channel-manager/worker/channelQueueWorker');
  const { BACKOFF_MS } = require('../../src/channel-manager/worker/workerRetryPolicy');

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

  async function insertRow(tenant, { reservationId, action = 'CREATE_BOOKING', channel = 'QYRVIA_CONNECT', retryCount = 0, status = 'PENDING' }) {
    const id = crypto.randomUUID();
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query(
        `INSERT INTO channel_sync_queue_store (id, tenant_id, property_id, reservation_id, action, channel, status, retry_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, tenant.tenantId, tenant.propertyId, reservationId, action, channel, status, retryCount]
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

  /** Approved data-level fixture manipulation: force a row's next_retry_at into the past. */
  async function forceRowDue(tenant, id) {
    await H.withTenant(pool, tenant.tenantId, (c) =>
      c.query("UPDATE channel_sync_queue_store SET next_retry_at = now() - interval '1 second' WHERE id=$1", [id])
    );
  }

  async function cleanupTenant(tenant) {
    if (!tenant) return;
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query('DELETE FROM channel_sync_queue_store WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM tenants WHERE id=$1', [tenant.tenantId]);
    });
  }

  function buildDbWorkerQueueAdapter() {
    return {
      dequeuePendingAcrossTenants: ({ limit } = {}) => dbm.dequeuePendingAcrossTenants({ pool, limit }),
      markCompleted: (tenantId, id) => dbm.markQueueCompletedForTenant({ pool, tenantId, id }),
      markRetryScheduled: (tenantId, id, nextRetryAt) => dbm.markQueueRetryScheduledForTenant({ pool, tenantId, id, nextRetryAt }),
      markDeadLetter:     (tenantId, id) => dbm.markQueueDeadLetterForTenant({ pool, tenantId, id })
    };
  }

  function makeSecretProvider() { return { async get() { return null; } }; }
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
  function makeFakeQtcnTransport(resultFn) {
    const calls = [];
    return { calls, async send(req) { calls.push(req); return typeof resultFn === 'function' ? resultFn(req) : { ok: true, status: 200, ackId: 'fake-ack' }; } };
  }

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regprocedure('worker_resolvers.pending_channel_tenants(integer)') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: worker_resolvers.pending_channel_tenants(integer) missing');
    const mig = await pool.query("SELECT count(*)::int AS c FROM schema_migrations WHERE version = $1", ['0086_channel_queue_retry_dead_letter']);
    assert.equal(mig.rows[0].c, 1, 'migration 0086 must be applied before this suite runs');
    tenantA = await seedTenantProperty('B2M-A-' + Date.now().toString(36));
    tenantB = await seedTenantProperty('B2M-B-' + Date.now().toString(36));
  });

  after(async () => {
    if (pool) {
      await cleanupTenant(tenantA);
      await cleanupTenant(tenantB);
      await pool.end();
    }
  });

  // ---------------------------------------------------------------------
  // A. RETRY SCHEDULING
  // ---------------------------------------------------------------------
  test('A: a retryable failure on a fresh PENDING row schedules a durable retry with the exact expected next_retry_at', async () => {
    const id = await insertRow(tenantA, { reservationId: 'R-A-' + crypto.randomBytes(3).toString('hex') });
    const before_ = Date.now();

    const processor = { async process() { return { ok: false, error: 'transport_error' }; } };
    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'PENDING');
    assert.equal(claimed.retryScheduled, true);

    const row = await fetchRow(tenantA, id);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.retry_count, 1, 'retry_count increments exactly once');
    assert.equal(row.attempts, 1, 'attempts increments exactly once');
    assert.ok(row.next_retry_at instanceof Date);
    const expectedMin = before_ + BACKOFF_MS[0] - 5000; // 5s tolerance for test/DB round-trip time
    const expectedMax = Date.now() + BACKOFF_MS[0] + 5000;
    assert.ok(row.next_retry_at.getTime() >= expectedMin && row.next_retry_at.getTime() <= expectedMax,
      'next_retry_at falls within the expected backoff window for retry_count=0 (' + BACKOFF_MS[0] + 'ms)');
    assert.notEqual(row.status, 'COMPLETED');
    assert.notEqual(row.status, 'DEAD_LETTER');
  });

  // ---------------------------------------------------------------------
  // B. FUTURE RETRY IS NOT CLAIMED
  // ---------------------------------------------------------------------
  test('B: a tick before next_retry_at claims nothing and leaves the row exactly as scheduled', async () => {
    // The row from test A is still due in the future (backoff #1 is 60s).
    const idsBefore = await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query("SELECT id FROM channel_sync_queue_store WHERE tenant_id=$1 AND status='PENDING'", [tenantA.tenantId])
    );
    assert.equal(idsBefore.rows.length, 1, 'exactly the one not-yet-due retry row exists for tenant A');

    let processCalls = 0;
    const processor = { async process() { processCalls += 1; return { ok: true }; } };
    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    assert.equal(result.idle, true, 'the only PENDING row is not yet due');
    assert.equal(processCalls, 0);

    const row = await fetchRow(tenantA, idsBefore.rows[0].id);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.retry_count, 1, 'unchanged from test A');
  });

  // ---------------------------------------------------------------------
  // C. DUE RETRY IS CLAIMED
  // ---------------------------------------------------------------------
  test('C: forcing next_retry_at into the past makes the row claimable again; success completes it, no duplicate processing', async () => {
    const rowsBefore = await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query("SELECT id FROM channel_sync_queue_store WHERE tenant_id=$1 AND status='PENDING'", [tenantA.tenantId])
    );
    const id = rowsBefore.rows[0].id;
    await forceRowDue(tenantA, id);

    let processCalls = 0;
    const processor = { async process() { processCalls += 1; return { ok: true }; } };
    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    assert.equal(processCalls, 1, 'claimed exactly once');
    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'COMPLETED');

    const row = await fetchRow(tenantA, id);
    assert.equal(row.status, 'COMPLETED');

    // A further tick must not reprocess it.
    let secondCalls = 0;
    const secondProcessor = { async process() { secondCalls += 1; return { ok: true }; } };
    const secondWorker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor: secondProcessor, isDispatchEnabled: () => true, enabled: false });
    const secondResult = await secondWorker.tick();
    assert.equal(secondResult.idle, true);
    assert.equal(secondCalls, 0);
  });

  // ---------------------------------------------------------------------
  // D. RETRY EXHAUSTION
  // ---------------------------------------------------------------------
  test('D: a retryable failure at retry_count=max_retries-1 (the final allowed attempt) is dead-lettered, no further retry scheduled', async () => {
    // max_retries defaults to 4; retry_count=3 is the last attempt the
    // resolver's own (unmodifiable) retry_count < max_retries filter allows.
    const id = await insertRow(tenantA, { reservationId: 'R-A-EXHAUST-' + crypto.randomBytes(3).toString('hex'), retryCount: 3 });

    const processor = { async process() { return { ok: false, error: 'transport_error' }; } };
    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed, 'a retry_count=3 row is still < max_retries=4, so it IS claimable for its final attempt');
    assert.equal(claimed.status, 'DEAD_LETTER');

    const row = await fetchRow(tenantA, id);
    assert.equal(row.status, 'DEAD_LETTER');
    assert.equal(row.retry_count, 3, 'retry_count is preserved exactly as the number of retries already scheduled, not incremented on dead-letter');
    assert.equal(row.next_retry_at, null, 'next_retry_at is cleared on a terminal transition');

    // A later tick must never claim a DEAD_LETTER row again.
    let laterCalls = 0;
    const laterProcessor = { async process() { laterCalls += 1; return { ok: true }; } };
    const laterWorker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor: laterProcessor, isDispatchEnabled: () => true, enabled: false });
    await laterWorker.tick();
    assert.equal(laterCalls, 0);
  });

  // ---------------------------------------------------------------------
  // E. NON-RETRYABLE FAILURE
  // ---------------------------------------------------------------------
  test('E: a non-retryable failure code dead-letters immediately, even on a fresh row with full retry budget', async () => {
    const id = await insertRow(tenantA, { reservationId: 'R-A-NONRETRY-' + crypto.randomBytes(3).toString('hex'), retryCount: 0 });

    const processor = { async process() { return { ok: false, error: 'no_provider_for_channel' }; } };
    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'DEAD_LETTER');

    const row = await fetchRow(tenantA, id);
    assert.equal(row.status, 'DEAD_LETTER');
    assert.equal(row.retry_count, 0, 'a non-retryable failure never increments retry_count — it never consumed a retry cycle');

    let laterCalls = 0;
    const laterProcessor = { async process() { laterCalls += 1; return { ok: true }; } };
    const laterWorker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor: laterProcessor, isDispatchEnabled: () => true, enabled: false });
    await laterWorker.tick();
    assert.equal(laterCalls, 0);
  });

  // ---------------------------------------------------------------------
  // F. REGISTRY DENIAL (real processor) — deny, then re-enable and complete
  // ---------------------------------------------------------------------
  test('F: registry-denied real-processor dispatch schedules a bounded retry (zero adapter calls); re-enabling before the due retry lets it complete', async () => {
    const id = await insertRow(tenantB, { reservationId: 'R-B-REGISTRY-' + crypto.randomBytes(3).toString('hex') });
    const registryState = { [tenantB.tenantId]: { QYRVIA_CONNECT: false } };
    const registry = makeFakeRegistry(registryState);
    const qtcn = makeFakeQtcnTransport();
    const processor = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: qtcn });

    const worker = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor, isDispatchEnabled: () => true, enabled: false });
    const result = await worker.tick();

    const claimed = result.results.find((r) => r.id === id);
    assert.ok(claimed);
    assert.equal(claimed.status, 'PENDING');
    assert.equal(claimed.skipped, true);
    assert.equal(qtcn.calls.length, 0, 'no external call while the registry denies the channel');

    // Registry is re-evaluated fresh on the next attempt: flip it enabled and
    // force the row due, then tick again with a fresh authorized transport.
    registryState[tenantB.tenantId].QYRVIA_CONNECT = true;
    await forceRowDue(tenantB, id);

    const qtcn2 = makeFakeQtcnTransport(() => ({ ok: true, status: 200, ackId: 'fake-ack-reenabled' }));
    const processor2 = buildRealProcessor({ secretProvider: makeSecretProvider(), channelRegistry: registry, qtcnTransport: qtcn2 });
    const worker2 = buildChannelQueueWorker({ queue: buildDbWorkerQueueAdapter(), processor: processor2, isDispatchEnabled: () => true, enabled: false });
    const result2 = await worker2.tick();

    const claimed2 = result2.results.find((r) => r.id === id);
    assert.ok(claimed2);
    assert.equal(claimed2.status, 'COMPLETED');
    assert.equal(qtcn2.calls.length, 1, 'the registry re-evaluation permitted exactly one dispatch once re-enabled');

    const row = await fetchRow(tenantB, id);
    assert.equal(row.status, 'COMPLETED');
  });

  // ---------------------------------------------------------------------
  // G. ACTIVE-STATE DEDUPE
  // ---------------------------------------------------------------------
  test('G: a duplicate PENDING row cannot coexist with an existing PENDING/PROCESSING row for the same dedupe key; terminal history does not block a legitimate new row', async () => {
    const reservationId = 'R-A-DEDUPE-' + crypto.randomBytes(3).toString('hex');
    const firstId = await insertRow(tenantA, { reservationId, action: 'CREATE_BOOKING', channel: 'QYRVIA_CONNECT' });

    let violated = false;
    let sqlstate = null;
    await H.withTenant(pool, tenantA.tenantId, async (c) => {
      try {
        await c.query(
          `INSERT INTO channel_sync_queue_store (id, tenant_id, property_id, reservation_id, action, channel, status)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING')`,
          [crypto.randomUUID(), tenantA.tenantId, tenantA.propertyId, reservationId, 'CREATE_BOOKING', 'QYRVIA_CONNECT']
        );
      } catch (e) {
        violated = true;
        sqlstate = e.code;
      }
    });
    assert.equal(violated, true, 'a second PENDING row for the exact same (tenant, reservation, action, channel) must be rejected');
    assert.equal(sqlstate, '23505', 'rejected specifically as a unique-constraint violation, not some other error class');

    // Move the first row to PROCESSING directly (data-level fixture, not via
    // the worker — deterministic and avoids any lingering async state) and
    // prove a duplicate is STILL rejected while it is actively being
    // processed (the pre-B2M gap this migration's widened index closed).
    await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query("UPDATE channel_sync_queue_store SET status='PROCESSING' WHERE id=$1", [firstId])
    );

    let violatedWhileProcessing = false;
    await H.withTenant(pool, tenantA.tenantId, async (c) => {
      try {
        await c.query(
          `INSERT INTO channel_sync_queue_store (id, tenant_id, property_id, reservation_id, action, channel, status)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING')`,
          [crypto.randomUUID(), tenantA.tenantId, tenantA.propertyId, reservationId, 'CREATE_BOOKING', 'QYRVIA_CONNECT']
        );
      } catch (e) {
        violatedWhileProcessing = (e.code === '23505');
      }
    });
    assert.equal(violatedWhileProcessing, true, 'the widened index must also reject a duplicate while the original row is PROCESSING');

    // Force the stuck row to a terminal state directly (data-level cleanup,
    // not a production concern) so it doesn't leak into later tests, then
    // prove a fresh row with the SAME key is now accepted.
    await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query("UPDATE channel_sync_queue_store SET status='DEAD_LETTER' WHERE id=$1", [firstId])
    );
    let terminalHistoryBlocks = false;
    await H.withTenant(pool, tenantA.tenantId, async (c) => {
      try {
        await c.query(
          `INSERT INTO channel_sync_queue_store (id, tenant_id, property_id, reservation_id, action, channel, status)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING')`,
          [crypto.randomUUID(), tenantA.tenantId, tenantA.propertyId, reservationId, 'CREATE_BOOKING', 'QYRVIA_CONNECT']
        );
      } catch (e) {
        terminalHistoryBlocks = true;
      }
    });
    assert.equal(terminalHistoryBlocks, false, 'a DEAD_LETTER (terminal) row must not permanently block a legitimate new row with the same key');
  });

  // ---------------------------------------------------------------------
  // H. CONCURRENCY
  // ---------------------------------------------------------------------
  test('H: concurrent tenant-bound claim attempts claim a row at most once, with no cross-tenant claim', async () => {
    const idA = await insertRow(tenantA, { reservationId: 'R-A-CONC-' + crypto.randomBytes(3).toString('hex') });
    const idB = await insertRow(tenantB, { reservationId: 'R-B-CONC-' + crypto.randomBytes(3).toString('hex') });

    const [batch1, batch2] = await Promise.all([
      dbm.dequeuePendingAcrossTenants({ pool, limit: 25 }),
      dbm.dequeuePendingAcrossTenants({ pool, limit: 25 })
    ]);
    const allClaimed = [...batch1, ...batch2];
    const claimedIds = allClaimed.map((r) => r.id);

    assert.equal(new Set(claimedIds).size, claimedIds.length, 'no row was claimed twice across the two concurrent calls');
    for (const r of allClaimed) {
      if (r.id === idA) assert.equal(r.tenant_id, tenantA.tenantId, 'tenant A\'s row must never be attributed to tenant B');
      if (r.id === idB) assert.equal(r.tenant_id, tenantB.tenantId, 'tenant B\'s row must never be attributed to tenant A');
    }

    // Clean these two up directly (not exercised through the worker in this test).
    await H.withTenant(pool, tenantA.tenantId, (c) => c.query('DELETE FROM channel_sync_queue_store WHERE id=$1', [idA]));
    await H.withTenant(pool, tenantB.tenantId, (c) => c.query('DELETE FROM channel_sync_queue_store WHERE id=$1', [idB]));
  });

  // ---------------------------------------------------------------------
  // I. POST-TEST SECURITY POSTURE
  // ---------------------------------------------------------------------
  test('I: database security posture is unchanged after the full retry/dead-letter/dedupe/concurrency cycle', async () => {
    const r = await pool.query(`SELECT json_build_object(
      'qyrvia_test', (SELECT json_build_object('can_login', rolcanlogin, 'is_superuser', rolsuper, 'bypassrls', rolbypassrls) FROM pg_roles WHERE rolname='qyrvia_test'),
      'qyrvia_auth_resolver', (SELECT json_build_object('can_login', rolcanlogin, 'is_superuser', rolsuper, 'bypassrls', rolbypassrls) FROM pg_roles WHERE rolname='qyrvia_auth_resolver'),
      'queue_owner', (SELECT pg_get_userbyid(relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='channel_sync_queue_store'),
      'queue_rls', (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='channel_sync_queue_store'),
      'queue_force_rls', (SELECT relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='channel_sync_queue_store'),
      'migration_0085_count', (SELECT count(*)::int FROM schema_migrations WHERE version='0085_worker_resolver_source_column_grants'),
      'migration_0086_count', (SELECT count(*)::int FROM schema_migrations WHERE version='0086_channel_queue_retry_dead_letter'),
      'queue_columns', (SELECT coalesce(json_agg(column_name ORDER BY column_name),'[]'::json) FROM information_schema.column_privileges WHERE grantee='qyrvia_auth_resolver' AND table_schema='public' AND table_name='channel_sync_queue_store' AND privilege_type='SELECT'),
      'table_wide_select', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a WHERE n.nspname='public' AND c.relname IN ('channel_sync_queue_store','scheduled_jobs') AND pg_get_userbyid(a.grantee)='qyrvia_auth_resolver' AND a.privilege_type='SELECT'),
      'public_column_priv', (SELECT count(*) FROM information_schema.column_privileges WHERE grantee='PUBLIC' AND table_schema='public' AND table_name IN ('channel_sync_queue_store','scheduled_jobs'))
    ) AS doc`);
    const doc = r.rows[0].doc;

    assert.equal(doc.qyrvia_test.can_login, true);
    assert.equal(doc.qyrvia_test.is_superuser, false);
    assert.equal(doc.qyrvia_test.bypassrls, false);
    assert.equal(doc.qyrvia_auth_resolver.can_login, false);
    assert.equal(doc.qyrvia_auth_resolver.is_superuser, false);
    assert.equal(doc.qyrvia_auth_resolver.bypassrls, true);
    assert.equal(doc.queue_owner, 'qyrvia_test');
    assert.equal(doc.queue_rls, true);
    assert.equal(doc.queue_force_rls, true);
    assert.equal(doc.migration_0085_count, 1);
    assert.equal(doc.migration_0086_count, 1);
    assert.deepEqual(doc.queue_columns, ['max_retries', 'next_retry_at', 'next_run_at', 'retry_count', 'status', 'tenant_id']);
    assert.equal(doc.table_wide_select, 0);
    assert.equal(doc.public_column_priv, 0);
  });
}
