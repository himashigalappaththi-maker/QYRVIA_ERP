'use strict';

/**
 * Phase 68B (instruction 044) — the durable per-channel ARI delivery ledger
 * (ari_outbox_channel_delivery, migration 0091) against REAL PostgreSQL,
 * through the real production persistence path
 * (src/ari/dispatch/ariChannelDeliveryStore.js + tenantAriChannelDelivery.js),
 * exercised alongside its parent table's own real path
 * (src/ari/outbox/ariOutboxStore.js + tenantAriOutbox.js) so every FK/RLS/
 * uniqueness/concurrency assertion runs against genuine rows, not fixtures.
 *
 * Runs under `npm run test:db` (or an equivalent explicit
 * TEST_DATABASE_URL invocation) — never under `npm run test:unit`. Follows
 * the SAME convention as every sibling Phase 66A DB test in this directory
 * (e.g. phase66a_b2nb_ari_outbox.db.test.js): no DDL, no CREATE ROLE, no
 * DROP SCHEMA, no migration run inside this file — migration 0091 must
 * already be applied through the standard runner before this file is run.
 * Single existing non-superuser role (qyrvia_test); fixtures cleaned up with
 * DELETE of only the rows this file created.
 *
 * SAFETY GUARD (instruction 044 Section 15): this file hard-refuses to run
 * any mutation against an unsafe target — a wrong database name, a non-local
 * host, or a superuser/BYPASSRLS connection each abort the WHOLE file via a
 * thrown assertion in `before()`, never a silent skip that could be mistaken
 * for a pass.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');
const G = require('./_rlsGuard');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  const { enqueueForTenant: enqueueAriOutboxForTenant } = require('../../src/ari/outbox/tenantAriOutbox');
  const {
    ensureDeliveryForTenant, claimForTenant, markCompletedForTenant,
    markRetryForTenant, markDeadLetterForTenant, listForOutboxEventForTenant
  } = require('../../src/ari/dispatch/tenantAriChannelDelivery');

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

  /** Create a real, tenant-owned ari_outbox_store row to hang deliveries off of. */
  async function seedAriOutboxRow(tenant, over = {}) {
    const event = Object.assign({
      tenantId: tenant.tenantId,
      propertyId: tenant.propertyId,
      eventType: 'INVENTORY_CHANGED',
      roomTypeId: 'rt-p68',
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-08-02',
      sourceVersion: 1,
      payload: { sold: 1 }
    }, over);
    const r = await enqueueAriOutboxForTenant({ pool, tenantId: tenant.tenantId, event });
    assert.equal(r.accepted, true, 'seed ari_outbox_store row must be freshly accepted');
    return r.row;
  }

  async function fetchDelivery(tenant, id) {
    return H.withTenant(pool, tenant.tenantId, async (c) => {
      const r = await c.query('SELECT * FROM ari_outbox_channel_delivery WHERE id=$1', [id]);
      return r.rows[0] || null;
    });
  }

  async function cleanupTenant(tenant) {
    if (!tenant) return;
    await H.withTenant(pool, tenant.tenantId, async (c) => {
      await c.query('DELETE FROM ari_outbox_channel_delivery WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM ari_outbox_store WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenant.tenantId]);
      await c.query('DELETE FROM tenants WHERE id=$1', [tenant.tenantId]);
    });
  }

  before(async () => {
    pool = H.newPool(URL);

    // ---- Hard safety guard: fail closed on ANY unsafe target, never skip. ----
    const target = await pool.query('SELECT current_database() AS db, inet_server_addr()::text AS addr');
    const db = target.rows[0].db;
    const addr = target.rows[0].addr;
    assert.equal(db, 'qyrvia_test', 'SAFETY ABORT: this file must only run against the qyrvia_test database');
    assert.ok(
      addr === null || addr === '127.0.0.1/32' || addr === '::1/128',
      'SAFETY ABORT: this file must only run against a local/loopback PostgreSQL server, got ' + addr
    );
    // Reuses the shared RLS guard — the SAME check every other DB test/CI
    // preflight in this repository already relies on: never validate RLS on
    // a superuser/BYPASSRLS connection.
    const roleInfo = await G.assertRlsCapableRole(pool);
    assert.equal(roleInfo.role, 'qyrvia_test', 'SAFETY ABORT: expected the ordinary qyrvia_test runtime role');

    tenantA = await seedTenantProperty('P68A');
    tenantB = await seedTenantProperty('P68B');
  });

  after(async () => {
    await cleanupTenant(tenantA);
    await cleanupTenant(tenantB);
    if (pool) await pool.end();
  });

  // ---- A-E. table/RLS/policy existence -------------------------------------

  test('A. ari_outbox_channel_delivery exists', async () => {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ari_outbox_channel_delivery'`);
    assert.equal(r.rows.length, 1);
  });

  test('B/C. RLS and FORCE RLS are enabled', async () => {
    const r = await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='ari_outbox_channel_delivery'`);
    assert.equal(r.rows[0].relrowsecurity, true, 'RLS enabled');
    assert.equal(r.rows[0].relforcerowsecurity, true, 'FORCE RLS enabled');
  });

  test('D/E. the tenant policy carries both USING and WITH CHECK', async () => {
    const r = await pool.query(
      `SELECT qual, with_check FROM pg_policies
        WHERE schemaname='public' AND tablename='ari_outbox_channel_delivery'
          AND policyname='ari_outbox_channel_delivery_by_app'`);
    assert.equal(r.rows.length, 1);
    assert.ok(r.rows[0].qual, 'USING expression present');
    assert.ok(r.rows[0].with_check, 'WITH CHECK expression present');
    assert.match(r.rows[0].with_check, /app_current_tenant/);
  });

  // ---- F/G/H. cross-tenant denial ------------------------------------------

  test('F/G/H. tenant A can neither SELECT, INSERT, nor UPDATE tenant B delivery rows', async () => {
    const outboxB = await seedAriOutboxRow(tenantB, { roomTypeId: 'rt-xt' });
    const ensured = await ensureDeliveryForTenant({
      pool, tenantId: tenantB.tenantId, propertyId: tenantB.propertyId,
      ariOutboxId: outboxB.id, channelCode: 'BOOKING_COM',
      dedupeKey: outboxB.dedupe_key, sourceVersion: outboxB.source_version
    });
    const bDeliveryId = ensured.row.id;

    // F. SELECT
    const seenFromA = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query('SELECT * FROM ari_outbox_channel_delivery WHERE id=$1', [bDeliveryId]);
      return r.rows.length;
    });
    assert.equal(seenFromA, 0, 'FORCE RLS hides tenant B delivery rows from tenant A');

    // G. INSERT — a raw cross-tenant INSERT attempt while bound to tenant A,
    // but explicitly stamped with tenant B's id, must violate WITH CHECK.
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(
        `INSERT INTO ari_outbox_channel_delivery
           (tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version)
         VALUES ($1,$2,$3,'QYRVIA_CONNECT','k-cross-insert',1)`,
        [tenantB.tenantId, tenantB.propertyId, outboxB.id]
      )), (e) => H.isPgError(e, '42501') || H.isPgError(e, '23'),
      'cross-tenant INSERT while bound to tenant A must be rejected');

    // H. UPDATE
    const mutatedFromA = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query("UPDATE ari_outbox_channel_delivery SET status='DEAD_LETTER' WHERE id=$1 RETURNING id", [bDeliveryId]);
      return r.rows.length;
    });
    assert.equal(mutatedFromA, 0, 'wrong-tenant UPDATE affects zero rows');
    assert.equal((await fetchDelivery(tenantB, bDeliveryId)).status, 'PENDING', 'tenant B row is untouched');
  });

  // ---- I. same-tenant operations succeed -----------------------------------

  test('I. same-tenant ensure/claim/complete succeeds end-to-end', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-same' });
    const ensured = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    assert.equal(ensured.created, true);
    const claimed = await claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id });
    assert.equal(claimed.status, 'PROCESSING');
    const completed = await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id, providerAckId: 'ACK-SAME' });
    assert.equal(completed.status, 'COMPLETED');
  });

  // ---- J. uniqueness --------------------------------------------------------

  test('J. UNIQUE (tenant_id, ari_outbox_id, channel_code) is database-enforced', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-uniq' });
    const first = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    assert.equal(first.created, true);

    // Raw INSERT deliberately bypasses ensureDelivery()'s own ON CONFLICT
    // handling, so the DATABASE constraint itself is what gets proven.
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(
        `INSERT INTO ari_outbox_channel_delivery
           (tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version)
         VALUES ($1,$2,$3,'BOOKING_COM',$4,$5)`,
        [tenantA.tenantId, tenantA.propertyId, outbox.id, outbox.dedupe_key, outbox.source_version]
      )), (e) => H.isPgError(e, '23505'), 'a second raw INSERT for the same (tenant, outbox, channel) must violate uq_aocd_event_channel');
  });

  // ---- K/L/M. canonical channel_code enforcement ---------------------------

  test('K/L. BOOKING_COM and QYRVIA_CONNECT are accepted canonical channel_code values', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-canon' });
    const bookingCom = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    assert.equal(bookingCom.row.channel_code, 'BOOKING_COM');
    const qyrviaConnect = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'QYRVIA_CONNECT',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    assert.equal(qyrviaConnect.row.channel_code, 'QYRVIA_CONNECT');
  });

  test('M. QTCN is rejected as a new canonical delivery write (raw INSERT, database CHECK)', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-qtcn' });
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(
        `INSERT INTO ari_outbox_channel_delivery
           (tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version)
         VALUES ($1,$2,$3,'QTCN',$4,$5)`,
        [tenantA.tenantId, tenantA.propertyId, outbox.id, outbox.dedupe_key, outbox.source_version]
      )), (e) => H.isPgError(e, '23514'), 'QTCN must violate aocd_channel_code_check — it is a legacy read-only alias, never writable');
  });

  // ---- N/O/P/Q. same-tenant FKs enforced, cross-tenant FKs rejected --------

  test('N/O. same-tenant ari_outbox and property FKs allow a legitimately-owned row', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-fk-ok' });
    const ensured = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    assert.equal(ensured.created, true);
    assert.equal(ensured.row.ari_outbox_id, outbox.id);
    assert.equal(ensured.row.property_id, tenantA.propertyId);
  });

  test('P. a cross-tenant ari_outbox_id reference is rejected by the composite same-tenant FK', async () => {
    const outboxB = await seedAriOutboxRow(tenantB, { roomTypeId: 'rt-fk-cross-outbox' });
    // Raw INSERT bound to tenant A's context but pointing at tenant B's
    // outbox row — must fail the composite (tenant_id, ari_outbox_id) FK,
    // independent of and in addition to RLS.
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(
        `INSERT INTO ari_outbox_channel_delivery
           (tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version)
         VALUES ($1,$2,$3,'BOOKING_COM','k-fk-cross-outbox',1)`,
        [tenantA.tenantId, tenantA.propertyId, outboxB.id]
      )), (e) => H.isPgError(e, '23'), 'cross-tenant ari_outbox_id must violate aocd_outbox_same_tenant_fk (or be invisible under RLS, also a 23-class/42501 failure)');
  });

  test('Q. a cross-tenant property_id reference is rejected by the composite same-tenant FK', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-fk-cross-prop' });
    await assert.rejects(() => H.withTenant(pool, tenantA.tenantId, (c) =>
      c.query(
        `INSERT INTO ari_outbox_channel_delivery
           (tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version)
         VALUES ($1,$2,$3,'BOOKING_COM','k-fk-cross-prop',1)`,
        [tenantA.tenantId, tenantB.propertyId, outbox.id]
      )), (e) => H.isPgError(e, '23'), 'cross-tenant property_id must violate aocd_property_same_tenant_fk');
  });

  // ---- R/S. idempotency and concurrent-create safety -----------------------

  test('R. ensureDelivery() is idempotent against real PostgreSQL', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-idem' });
    const a = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    const b = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.row.id, b.row.id);
    const rows = await listForOutboxEventForTenant({ pool, tenantId: tenantA.tenantId, ariOutboxId: outbox.id });
    assert.equal(rows.filter((r) => r.channel_code === 'BOOKING_COM').length, 1);
  });

  test('S. two near-simultaneous ensureDelivery() attempts for the SAME event/channel create exactly one durable row', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-conc-ensure' });
    const [r1, r2] = await Promise.all([
      ensureDeliveryForTenant({
        pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
        ariOutboxId: outbox.id, channelCode: 'QYRVIA_CONNECT',
        dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
      }),
      ensureDeliveryForTenant({
        pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
        ariOutboxId: outbox.id, channelCode: 'QYRVIA_CONNECT',
        dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
      })
    ]);
    assert.equal([r1, r2].filter((r) => r.created).length, 1, 'exactly one concurrent ensure inserted');
    const rows = await H.withTenant(pool, tenantA.tenantId, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM ari_outbox_channel_delivery
          WHERE tenant_id=$1 AND ari_outbox_id=$2 AND channel_code='QYRVIA_CONNECT'`,
        [tenantA.tenantId, outbox.id]);
      return r.rows[0].n;
    });
    assert.equal(rows, 1);
  });

  // ---- T/U. completed-state protection and concurrent claim ---------------

  test('T. a COMPLETED delivery can never be reclaimed', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-completed' });
    const ensured = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    await claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id });
    await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id, providerAckId: 'ACK-T' });
    const reclaim = await claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id });
    assert.equal(reclaim, null, 'a COMPLETED row is never reclaimed');
  });

  test('U. concurrent claim attempts on the same PENDING delivery produce exactly one winner', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-conc-claim' });
    const ensured = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    const [c1, c2] = await Promise.all([
      claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id }),
      claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id })
    ]);
    const winners = [c1, c2].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one concurrent claimer won (FOR UPDATE SKIP LOCKED)');
    assert.equal(winners[0].status, 'PROCESSING');
  });

  // ---- V/W/X. state persistence --------------------------------------------

  test('V. RETRY state persists correctly, including attempt_count', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-retry' });
    const ensured = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    await claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id });
    const retried = await markRetryForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id, errorCode: 'http_503', errorClass: 'RETRYABLE' });
    assert.equal(retried.status, 'RETRY');
    assert.equal(retried.attempt_count, 1);
    assert.equal(retried.last_error_code, 'http_503');
    const persisted = await fetchDelivery(tenantA, ensured.row.id);
    assert.equal(persisted.status, 'RETRY');
    assert.equal(persisted.attempt_count, 1);
  });

  test('W. DEAD_LETTER state persists correctly and is terminal', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-dead' });
    const ensured = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    await claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id });
    const dead = await markDeadLetterForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id, errorCode: 'MISSING_CREDENTIAL_REF', errorClass: 'NON_RETRYABLE' });
    assert.equal(dead.status, 'DEAD_LETTER');
    assert.equal(dead.attempt_count, 1);
    assert.equal(dead.last_error_code, 'MISSING_CREDENTIAL_REF');
    const reclaim = await claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id });
    assert.equal(reclaim, null, 'DEAD_LETTER is terminal — never reclaimed');
  });

  test('X. provider_ack_id persists only on completion', async () => {
    const outbox = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-ack' });
    const ensured = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outbox.id, channelCode: 'BOOKING_COM',
      dedupeKey: outbox.dedupe_key, sourceVersion: outbox.source_version
    });
    assert.equal((await fetchDelivery(tenantA, ensured.row.id)).provider_ack_id, null, 'no ack id before completion');
    await claimForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id });
    const completed = await markCompletedForTenant({ pool, tenantId: tenantA.tenantId, id: ensured.row.id, providerAckId: 'BOOKING-ACK-123' });
    assert.equal(completed.provider_ack_id, 'BOOKING-ACK-123');
    assert.equal((await fetchDelivery(tenantA, ensured.row.id)).provider_ack_id, 'BOOKING-ACK-123');
  });

  // ---- Y. pooled tenant-context leakage ------------------------------------

  test('Y. tenant context does not leak between pooled transactions/connections', async () => {
    const outboxA = await seedAriOutboxRow(tenantA, { roomTypeId: 'rt-leak-a' });
    const outboxB = await seedAriOutboxRow(tenantB, { roomTypeId: 'rt-leak-b' });
    const ensuredA = await ensureDeliveryForTenant({
      pool, tenantId: tenantA.tenantId, propertyId: tenantA.propertyId,
      ariOutboxId: outboxA.id, channelCode: 'BOOKING_COM',
      dedupeKey: outboxA.dedupe_key, sourceVersion: outboxA.source_version
    });
    const ensuredB = await ensureDeliveryForTenant({
      pool, tenantId: tenantB.tenantId, propertyId: tenantB.propertyId,
      ariOutboxId: outboxB.id, channelCode: 'BOOKING_COM',
      dedupeKey: outboxB.dedupe_key, sourceVersion: outboxB.source_version
    });

    // Interleave many alternating tenant-bound units of work across the SAME
    // pool. Each `withTenant` call takes a (possibly reused) pooled
    // connection and binds app.tenant_id LOCAL to its own transaction
    // (tenantUnitOfWork.js's set_config(..., is_local => true)). If tenant
    // context ever leaked to a connection handed to the wrong tenant next,
    // one of these reads would see the other tenant's row.
    const rounds = 20;
    for (let i = 0; i < rounds; i++) {
      const seenA = await H.withTenant(pool, tenantA.tenantId, async (c) => {
        const r = await c.query('SELECT id FROM ari_outbox_channel_delivery WHERE id=$1', [ensuredB.row.id]);
        return r.rows.length;
      });
      assert.equal(seenA, 0, 'round ' + i + ': tenant A context leaked into seeing tenant B row');
      const seenB = await H.withTenant(pool, tenantB.tenantId, async (c) => {
        const r = await c.query('SELECT id FROM ari_outbox_channel_delivery WHERE id=$1', [ensuredA.row.id]);
        return r.rows.length;
      });
      assert.equal(seenB, 0, 'round ' + i + ': tenant B context leaked into seeing tenant A row');
    }

    // Concurrent interleaving too, not just sequential alternation.
    const results = await Promise.all([
      H.withTenant(pool, tenantA.tenantId, (c) => c.query('SELECT id FROM ari_outbox_channel_delivery WHERE id=$1', [ensuredA.row.id]).then((r) => r.rows.length)),
      H.withTenant(pool, tenantB.tenantId, (c) => c.query('SELECT id FROM ari_outbox_channel_delivery WHERE id=$1', [ensuredA.row.id]).then((r) => r.rows.length)),
      H.withTenant(pool, tenantA.tenantId, (c) => c.query('SELECT id FROM ari_outbox_channel_delivery WHERE id=$1', [ensuredB.row.id]).then((r) => r.rows.length)),
      H.withTenant(pool, tenantB.tenantId, (c) => c.query('SELECT id FROM ari_outbox_channel_delivery WHERE id=$1', [ensuredB.row.id]).then((r) => r.rows.length))
    ]);
    assert.deepEqual(results, [1, 0, 0, 1], 'concurrent interleaved tenant-bound connections never cross-see rows');
  });
}
