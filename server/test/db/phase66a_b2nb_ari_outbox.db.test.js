'use strict';

/**
 * Phase 66A-B2N-B — durable ARI outbox (ari_outbox_store, migration 0087)
 * against REAL PostgreSQL, through the real production persistence path
 * (src/ari/outbox/ariOutboxStore.js + tenantAriOutbox.js).
 *
 * PREPARED IN B2N-B, RUN ONLY AFTER MIGRATION 0087 IS SEPARATELY APPROVED
 * AND APPLIED through the standard runner. Runs under `npm run test:db`
 * (which this phase must not invoke) — never under `npm run test:unit`.
 *
 * STRICT data-level boundary, same as every sibling B2H-B2M DB test: no DDL,
 * no CREATE ROLE, no DROP SCHEMA, no migration run inside this file; single
 * existing role; fixtures cleaned up with DELETE of only the rows this file
 * created. Zero live network activity. "Due retry" cases set next_retry_at
 * directly to a past timestamp via an approved data-level UPDATE fixture.
 *
 * Covers the 20 required proof points of the B2N-B instruction, Section 16.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  const {
    withTenantAriOutbox, enqueueForTenant, claimDueForTenant,
    markCompletedForTenant, markRetryScheduledForTenant, markDeadLetterForTenant,
    requeueExpiredLeasesForTenant
  } = require('../../src/ari/outbox/tenantAriOutbox');

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

  function validEvent(tenant, over = {}) {
    return Object.assign({
      tenantId: tenant.tenantId,
      propertyId: tenant.propertyId,
      eventType: 'INVENTORY_CHANGED',
      roomTypeId: 'rt1',
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-08-02',
      sourceVersion: 1,
      payload: { sold: 2 }
    }, over);
  }

  async function fetchRow(tenant, id) {
    return H.withTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query('SELECT * FROM ari_outbox_store WHERE id=$1', [id]);
      return r.rows[0] || null;
    });
  }

  /** Approved data-level fixture: force a PENDING row's next_retry_at into the past. */
  async function forceDue(tenant, id) {
    await H.withTenant(pool, tenant.tenantId, (c) =>
      c.query("UPDATE ari_outbox_store SET next_retry_at = now() - interval '1 second' WHERE id=$1", [id]));
  }

  async function cleanupTenant(tenant) {
    if (!tenant) return;
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query('DELETE FROM ari_outbox_store WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM tenants WHERE id=$1', [tenant.tenantId]);
    });
  }

  before(async () => {
    pool = H.newPool(URL);
    tenantA = await seedTenantProperty('OBA');
    tenantB = await seedTenantProperty('OBB');
  });

  after(async () => {
    await cleanupTenant(tenantA);
    await cleanupTenant(tenantB);
    if (pool) await pool.end();
  });

  // 1. table exists with exact columns
  // PHASE 68B (instruction 046): this list predated migration 0088
  // (Phase 66A-B2N-C2), which added the nullable `restriction_rule_id`
  // column (VARCHAR(80), no FK — outbox history must survive rule deletion;
  // see 0088's own header). Confirmed via direct reading of 0088's DDL
  // (`ALTER TABLE ari_outbox_store ADD COLUMN restriction_rule_id
  // VARCHAR(80);`) and its own static contract test
  // (phase66a_migration_0088_ari_outbox_restriction_scope.test.js, test "A")
  // that this column is the CURRENT authoritative, intentional schema — not
  // a regression. Updated to include it; every other column is unchanged.
  test('1. ari_outbox_store exists with the exact contracted columns', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ari_outbox_store' ORDER BY column_name`);
    assert.deepEqual(r.rows.map((x) => x.column_name), [
      'attempts', 'completed_at', 'created_at', 'dead_lettered_at', 'dedupe_key',
      'effective_from', 'effective_to', 'event_type', 'id', 'lease_owner',
      'lease_until', 'max_retries', 'next_retry_at', 'payload_json',
      'property_id', 'rate_plan_id', 'resource_kind', 'restriction_rule_id', 'retry_count',
      'room_type_id', 'source_version', 'status', 'tenant_id', 'updated_at'
    ].sort());
  });

  // 2. status and event constraints enforce the contract
  test('2. status/event/compat CHECK constraints reject contract violations', async () => {
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(`INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key, status)
               VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY','rt1','2026-08-01','2026-08-02',1,'k-bad-status','RETRY_WAIT')`,
        [tenantA.tenantId, tenantA.propertyId])), (e) => H.isPgError(e, '23'));
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(`INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key)
               VALUES ($1,$2,'BOOKING_CHANGED','INVENTORY','rt1','2026-08-01','2026-08-02',1,'k-bad-event')`,
        [tenantA.tenantId, tenantA.propertyId])), (e) => H.isPgError(e, '23'));
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(`INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key)
               VALUES ($1,$2,'INVENTORY_CHANGED','RATE','rt1','2026-08-01','2026-08-02',1,'k-bad-compat')`,
        [tenantA.tenantId, tenantA.propertyId])), (e) => H.isPgError(e, '23'));
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(`INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, rate_plan_id, effective_from, effective_to, source_version, dedupe_key)
               VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY','rt1','rp1','2026-08-01','2026-08-02',1,'k-bad-rp')`,
        [tenantA.tenantId, tenantA.propertyId])), (e) => H.isPgError(e, '23'));
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(`INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key)
               VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY','rt1','2026-08-02','2026-08-01',1,'k-bad-range')`,
        [tenantA.tenantId, tenantA.propertyId])), (e) => H.isPgError(e, '23'));
  });

  // 3 + 4. RLS enabled and forced
  test('3/4. RLS and FORCE RLS are enabled on ari_outbox_store', async () => {
    const r = await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='ari_outbox_store'`);
    assert.equal(r.rows[0].relrowsecurity, true);
    assert.equal(r.rows[0].relforcerowsecurity, true);
  });

  // 5. role posture
  test('5. qyrvia_test remains LOGIN, non-superuser, NOBYPASSRLS', async () => {
    const r = await pool.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='qyrvia_test'`);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].rolcanlogin, true);
    assert.equal(r.rows[0].rolsuper, false);
    assert.equal(r.rows[0].rolbypassrls, false);
  });

  // 6 + 7. cross-tenant denial
  test('6/7. tenant A can neither read nor mutate tenant B rows', async () => {
    const enq = await enqueueForTenant({ pool, tenantId: tenantB.tenantId, event: validEvent(tenantB, { roomTypeId: 'rt-xt' }) });
    assert.equal(enq.accepted, true);
    const bRowId = enq.row.id;

    const seenFromA = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query('SELECT * FROM ari_outbox_store WHERE id=$1', [bRowId]);
      return r.rows.length;
    });
    assert.equal(seenFromA, 0, 'FORCE RLS hides tenant B rows from tenant A');

    const mutatedFromA = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query("UPDATE ari_outbox_store SET status='COMPLETED' WHERE id=$1 RETURNING id", [bRowId]);
      return r.rows.length;
    });
    assert.equal(mutatedFromA, 0, 'wrong-tenant mutation affects zero rows');
    assert.equal((await fetchRow(tenantB, bRowId)).status, 'PENDING');
  });

  // 8. active dedupe
  test('8. the same logical active event deduplicates to one row', async () => {
    const e = validEvent(tenantA, { roomTypeId: 'rt-dedupe', sourceVersion: 7 });
    const r1 = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: e });
    const r2 = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: e });
    assert.equal(r1.accepted, true);
    assert.equal(r2.accepted, false);
    assert.equal(r2.deduped, true);
    assert.equal(r2.existing.id, r1.row.id);
  });

  // 9. different source version accepted
  test('9. a different source version is accepted as a distinct row', async () => {
    const r8 = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-dedupe', sourceVersion: 8 }) });
    assert.equal(r8.accepted, true);
  });

  // 10. terminal history and global idempotency (final correction #1):
  // the SAME logical event deduplicates in EVERY status; only a later
  // VERSION creates a new row.
  test('10/G1-G8. identical logical event deduplicates across PENDING, PROCESSING, COMPLETED and DEAD_LETTER; a later version and a different period remain accepted; concurrent enqueue yields one row', async () => {
    const e = validEvent(tenantA, { roomTypeId: 'rt-term', sourceVersion: 2 });

    // G1: dedupe while PENDING
    const r1 = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: e });
    assert.equal(r1.accepted, true);
    const dupPending = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: e });
    assert.equal(dupPending.deduped, true);
    assert.equal(dupPending.existing.id, r1.row.id);
    assert.equal(dupPending.existing.status, 'PENDING');

    // G7: concurrent enqueue of the same logical event -> exactly one row
    const eConc = validEvent(tenantA, { roomTypeId: 'rt-conc-enq', sourceVersion: 1 });
    const [ca, cb] = await Promise.all([
      enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: eConc }),
      enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: eConc })
    ]);
    assert.equal([ca, cb].filter((r) => r.accepted).length, 1, 'exactly one concurrent enqueue inserted');
    const concRows = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM ari_outbox_store WHERE tenant_id=$1 AND room_type_id='rt-conc-enq'", [tenantA.tenantId]);
      return r.rows[0].n;
    });
    assert.equal(concRows, 1);

    // G2: dedupe while PROCESSING
    const claimed = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'db-test' });
    assert.ok(claimed.some((r) => r.id === r1.row.id));
    const dupProcessing = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: e });
    assert.equal(dupProcessing.deduped, true);
    assert.equal(dupProcessing.existing.status, 'PROCESSING');

    // G3: dedupe after COMPLETED
    await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: r1.row.id });
    const dupCompleted = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: e });
    assert.equal(dupCompleted.deduped, true, 'COMPLETED history deduplicates the identical event');
    assert.equal(dupCompleted.existing.status, 'COMPLETED');

    // G4: dedupe after DEAD_LETTER (separate row driven to DEAD_LETTER)
    const eDl = validEvent(tenantA, { roomTypeId: 'rt-term-dl', sourceVersion: 2 });
    const rDl = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: eDl });
    const claimedDl = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'db-test' });
    assert.ok(claimedDl.some((r) => r.id === rDl.row.id));
    await markDeadLetterForTenant({ pool, tenantId: tenantA.tenantId, id: rDl.row.id });
    const dupDead = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: eDl });
    assert.equal(dupDead.deduped, true, 'a DEAD_LETTER event is never silently re-inserted');
    assert.equal(dupDead.existing.status, 'DEAD_LETTER');

    // G5/G8: a later source version remains accepted after terminal history
    const laterVersion = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-term', sourceVersion: 3 }) });
    assert.equal(laterVersion.accepted, true, 'later source_version is a new logical event');

    // G6: a different legitimate effective period remains accepted
    const otherPeriod = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-term', sourceVersion: 2, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-02' }) });
    assert.equal(otherPeriod.accepted, true, 'different effective period is a new logical event');
  });

  // G9. the idempotency protection is the global constraint, not a partial index
  test('G9. uq_aob_logical_event is a full unique constraint and no partial unique index exists on ari_outbox_store', async () => {
    const con = await pool.query(
      `SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname='ari_outbox_store' AND con.conname='uq_aob_logical_event' AND con.contype='u'`);
    assert.equal(con.rows.length, 1);
    assert.match(con.rows[0].def, /UNIQUE \(tenant_id, property_id, dedupe_key\)/);
    const partials = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename='ari_outbox_store' AND indexdef LIKE 'CREATE UNIQUE%' AND indexdef LIKE '%WHERE%'`);
    assert.deepEqual(partials.rows, [], 'no status-limited unique index may exist');
  });

  // 11-13. claim due-ness
  test('11/12/13. future retry not claimable; due retry claimable; exhausted retry not claimable', async () => {
    const eFut = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-fut' }) });
    await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query("UPDATE ari_outbox_store SET next_retry_at = now() + interval '1 hour' WHERE id=$1", [eFut.row.id]));

    const eExh = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-exh' }) });
    await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query('UPDATE ari_outbox_store SET retry_count = max_retries WHERE id=$1', [eExh.row.id]));

    const eDue = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-due' }) });
    await forceDue(tenantA, eDue.row.id);

    const claimed = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'db-test' });
    const ids = claimed.map((r) => r.id);
    assert.ok(!ids.includes(eFut.row.id), 'future next_retry_at row was not claimed');
    assert.ok(!ids.includes(eExh.row.id), 'exhausted row was not claimed');
    assert.ok(ids.includes(eDue.row.id), 'due row was claimed');
    const dueRow = claimed.find((r) => r.id === eDue.row.id);
    assert.equal(dueRow.status, 'PROCESSING');
    assert.ok(dueRow.lease_until, 'claim set a lease');
    assert.equal(dueRow.lease_owner, 'db-test');
  });

  // 14. concurrent claims
  test('14. concurrent claims never double-claim a row (SKIP LOCKED)', async () => {
    const e = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-conc' }) });
    const [c1, c2] = await Promise.all([
      claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'w1' }),
      claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'w2' })
    ]);
    const hits = [...c1, ...c2].filter((r) => r.id === e.row.id);
    assert.equal(hits.length, 1, 'exactly one claimer got the row');
  });

  // 15-17. transitions
  test('15/16/17. completion, retry and dead-letter transitions work with exact B2M-compatible semantics', async () => {
    async function freshProcessingRow(roomTypeId) {
      const e = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId }) });
      const claimed = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'db-test' });
      assert.ok(claimed.some((r) => r.id === e.row.id));
      return e.row.id;
    }

    const doneId = await freshProcessingRow('rt-done');
    const done = await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: doneId });
    assert.equal(done.status, 'COMPLETED');
    assert.ok(done.completed_at);
    assert.equal(done.lease_until, null);

    const retryId = await freshProcessingRow('rt-retry');
    const retried = await markRetryScheduledForTenant({
      pool, tenantId: tenantA.tenantId, id: retryId,
      nextRetryAt: new Date(Date.now() + 3600000).toISOString()
    });
    assert.equal(retried.status, 'PENDING');
    assert.equal(retried.attempts, 1);
    assert.equal(retried.retry_count, 1);
    assert.ok(retried.next_retry_at);
    assert.equal(retried.lease_until, null);

    await forceDue(tenantA, retryId);
    const reclaimed = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'db-test' });
    assert.ok(reclaimed.some((r) => r.id === retryId), 'due retry is claimable again');
    const dead = await markDeadLetterForTenant({ pool, tenantId: tenantA.tenantId, id: retryId });
    assert.equal(dead.status, 'DEAD_LETTER');
    assert.equal(dead.attempts, 2, 'attempts incremented once per finished processing attempt');
    assert.equal(dead.retry_count, 1, 'retry_count preserved on dead-letter');
    assert.equal(dead.next_retry_at, null);
    assert.ok(dead.dead_lettered_at);

    const reclaim2 = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'db-test' });
    assert.ok(!reclaim2.some((r) => r.id === retryId), 'DEAD_LETTER row is terminal — never reclaimed');
    assert.ok(!reclaim2.some((r) => r.id === doneId), 'COMPLETED row is terminal — never reclaimed');
  });

  // 18. wrong-tenant transitions
  test('18. wrong-tenant transitions affect zero rows', async () => {
    const e = await enqueueForTenant({ pool, tenantId: tenantB.tenantId, event: validEvent(tenantB, { roomTypeId: 'rt-wrongt' }) });
    const claimed = await claimDueForTenant({ pool, tenantId: tenantB.tenantId, limit: 100, leaseOwner: 'db-test' });
    assert.ok(claimed.some((r) => r.id === e.row.id));
    const res = await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: e.row.id });
    assert.equal(res, null, 'tenant A cannot complete tenant B work');
    assert.equal((await fetchRow(tenantB, e.row.id)).status, 'PROCESSING');
    await markCompletedForTenant({ pool, tenantId: tenantB.tenantId, id: e.row.id });
  });

  // 19. no reservation queue coupling
  test('19. no channel_sync_queue_store row was created by any ARI outbox operation', async () => {
    for (const t of [tenantA, tenantB]) {
      const n = await H.withTenant(pool, t.tenantId, async (c) => {
        const r = await c.query('SELECT count(*)::int AS n FROM channel_sync_queue_store WHERE tenant_id=$1', [t.tenantId]);
        return r.rows[0].n;
      });
      assert.equal(n, 0);
    }
  });

  // 20. no reservation_id dependency
  test('20. ari_outbox_store has no reservation_id column at all', async () => {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ari_outbox_store' AND column_name='reservation_id'`);
    assert.equal(r.rows.length, 0);
  });

  // ---- B2N-B pre-application corrections ----------------------------------

  // C1/C2/C3. composite same-tenant property FK is database-enforced
  // PHASE 68B (instruction 046): the raw dedupe_key fixtures below used to be
  // plain strings ('k-fk-cross' / 'k-fk-own'), which migration 0088's
  // `ari_outbox_store_key_version_compat` CHECK now rejects for any row with
  // a NULL restriction_rule_id (non-restriction events, this test's case,
  // require the 'aob:v1:' prefix — confirmed by direct reading of 0088's own
  // CHECK definition and phase66a_migration_0088_..._test.js test "H"). The
  // SECOND insert here (expected to SUCCEED) was failing on that constraint
  // instead of proving what this test actually exists to prove — the
  // same-tenant composite FK. Prefixed both keys; this changes NOTHING about
  // which invariant is under test, only makes the fixture format-compliant
  // with the current, correct, unweakened constraint.
  test('C1/C2/C3. tenant A + tenant B property is rejected by the composite FK; tenant A + own property succeeds', async () => {
    // Raw INSERT deliberately bypasses the application validation layer so
    // the DATABASE constraint itself is what gets proven.
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(`INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key)
               VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY','rt-fk','2026-08-01','2026-08-02',1,'aob:v1:k-fk-cross')`,
        [tenantA.tenantId, tenantB.propertyId])),
      (e) => H.isPgError(e, '23'), 'cross-tenant property reference must violate the composite FK');

    const ok = await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(`INSERT INTO ari_outbox_store (tenant_id, property_id, event_type, resource_kind, room_type_id, effective_from, effective_to, source_version, dedupe_key)
               VALUES ($1,$2,'INVENTORY_CHANGED','INVENTORY','rt-fk','2026-08-01','2026-08-02',1,'aob:v1:k-fk-own')
               RETURNING id`,
        [tenantA.tenantId, tenantA.propertyId]));
    assert.equal(ok.rows.length, 1, 'same-tenant property reference succeeds');
  });

  // C4. policy has both USING and WITH CHECK
  test('C4. the RLS policy carries both an explicit USING and an explicit WITH CHECK expression', async () => {
    const r = await pool.query(
      `SELECT qual, with_check FROM pg_policies
        WHERE schemaname='public' AND tablename='ari_outbox_store' AND policyname='ari_outbox_store_by_app'`);
    assert.equal(r.rows.length, 1);
    assert.ok(r.rows[0].qual, 'USING expression present');
    assert.ok(r.rows[0].with_check, 'WITH CHECK expression present');
    assert.match(r.rows[0].with_check, /app\.tenant_id/);
  });

  // C5/C6/C7. expired-lease recovery
  test('C5/C6/C7. expired PROCESSING rows recover to PENDING and become claimable; unexpired leases are never broken', async () => {
    const eExp = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-lease-exp' }) });
    const eLive = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-lease-live' }) });
    const claimed = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'crashy', leaseMs: 3600000 });
    assert.ok(claimed.some((r) => r.id === eExp.row.id));
    assert.ok(claimed.some((r) => r.id === eLive.row.id));

    // Approved data-level fixture: expire ONE lease; leave the other active.
    await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query("UPDATE ari_outbox_store SET lease_until = now() - interval '1 second' WHERE id=$1", [eExp.row.id]));

    const recovered = await requeueExpiredLeasesForTenant({ pool, tenantId: tenantA.tenantId, limit: 100 });
    const recIds = recovered.map((r) => r.id);
    assert.ok(recIds.includes(eExp.row.id), 'expired lease recovered');
    assert.ok(!recIds.includes(eLive.row.id), 'active lease NOT recovered');

    const rec = recovered.find((r) => r.id === eExp.row.id);
    assert.equal(rec.status, 'PENDING');
    assert.equal(rec.lease_until, null);
    assert.equal(rec.lease_owner, null);
    assert.equal(rec.retry_count, 0, 'retry_count preserved');
    assert.equal(rec.attempts, 0, 'attempts preserved (crashed worker reported no finished attempt)');

    const reclaimed = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'w-after' });
    assert.ok(reclaimed.some((r) => r.id === eExp.row.id), 'recovered row is claimable again');
    assert.equal((await fetchRow(tenantA, eLive.row.id)).status, 'PROCESSING', 'live-leased row untouched throughout');
    await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: eExp.row.id });
    await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: eLive.row.id });
  });

  // C7b. wrong-tenant recovery affects zero rows
  test('C7b. wrong-tenant recovery affects zero rows', async () => {
    const e = await enqueueForTenant({ pool, tenantId: tenantB.tenantId, event: validEvent(tenantB, { roomTypeId: 'rt-lease-wrongt' }) });
    const claimed = await claimDueForTenant({ pool, tenantId: tenantB.tenantId, limit: 100, leaseOwner: 'crashy' });
    assert.ok(claimed.some((r) => r.id === e.row.id));
    await H.withTenant(pool, tenantB.tenantId, (c) =>
      c.query("UPDATE ari_outbox_store SET lease_until = now() - interval '1 second' WHERE id=$1", [e.row.id]));

    const recoveredByA = await requeueExpiredLeasesForTenant({ pool, tenantId: tenantA.tenantId, limit: 100 });
    assert.ok(!recoveredByA.some((r) => r.id === e.row.id), 'tenant A cannot recover tenant B rows');
    assert.equal((await fetchRow(tenantB, e.row.id)).status, 'PROCESSING');
    await requeueExpiredLeasesForTenant({ pool, tenantId: tenantB.tenantId, limit: 100 });
    const back = await fetchRow(tenantB, e.row.id);
    assert.equal(back.status, 'PENDING');
    await markCompletedForTenant({ pool, tenantId: tenantB.tenantId, id: (await claimDueForTenant({ pool, tenantId: tenantB.tenantId, limit: 100, leaseOwner: 'w' })).find((r) => r.id === e.row.id).id });
  });

  // C8. concurrent recovery/claim does not double-claim
  test('C8. concurrent recovery and claim never yield the same row twice as active work for two owners', async () => {
    const e = await enqueueForTenant({ pool, tenantId: tenantA.tenantId, event: validEvent(tenantA, { roomTypeId: 'rt-lease-race' }) });
    const claimed = await claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'crashy' });
    assert.ok(claimed.some((r) => r.id === e.row.id));
    await H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query("UPDATE ari_outbox_store SET lease_until = now() - interval '1 second' WHERE id=$1", [e.row.id]));

    // Two concurrent recoverers: SKIP LOCKED means exactly one flips the row.
    const [r1, r2] = await Promise.all([
      requeueExpiredLeasesForTenant({ pool, tenantId: tenantA.tenantId, limit: 100 }),
      requeueExpiredLeasesForTenant({ pool, tenantId: tenantA.tenantId, limit: 100 })
    ]);
    const flips = [...r1, ...r2].filter((r) => r.id === e.row.id);
    assert.equal(flips.length, 1, 'exactly one recoverer flipped the row');

    // And the recovered row is claimable by exactly one claimer.
    const [c1, c2] = await Promise.all([
      claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'wx' }),
      claimDueForTenant({ pool, tenantId: tenantA.tenantId, limit: 100, leaseOwner: 'wy' })
    ]);
    const hits = [...c1, ...c2].filter((r) => r.id === e.row.id);
    assert.equal(hits.length, 1, 'exactly one claimer got the recovered row');
    await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: e.row.id });
  });
}
