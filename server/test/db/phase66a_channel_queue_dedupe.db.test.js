'use strict';

/**
 * Phase 66A C3 — per-channel queue dedupe against REAL PostgreSQL.
 *
 * Migration 0084 replaces uq_csqs_pending — which was
 * (tenant_id, reservation_id, action) WHERE status='PENDING' — with a key that
 * also includes the channel. Without that change, one PMS event fanning out to
 * eight OTAs produces eight INSERTs that all conflict onto a single row, and
 * seven channels are silently dropped with no error anywhere. Migration 0086
 * later widened that key's predicate from PENDING-only to PENDING+PROCESSING
 * and renamed it uq_csqs_active_channel — see the GUARD test below, which
 * asserts the CURRENT (post-0086) contract, not the original 0084 name.
 *
 * These tests drive the REAL persistence store, inside the Phase 64 tenant unit
 * of work, under FORCE ROW LEVEL SECURITY.
 *
 * PHASE 68B REGRESSION-SAFETY CLOSURE (instruction 046): this file used to
 * call H.freshSchema(pool) in before() — DROP SCHEMA IF EXISTS public CASCADE
 * plus a full migration replay — against the shared, already-provisioned
 * qyrvia_test database every sibling DB test in this directory also runs
 * against. That is destructive to any state a concurrently-authored
 * instruction/session has already proven live (e.g. a freshly-applied
 * migration or a freshly-installed superuser bootstrap object in a DIFFERENT
 * schema) and violates this repository's standing live-test safety boundary.
 * This file now follows the SAME safe, non-destructive convention every other
 * file in this directory uses (see phase66a_b2nb_ari_outbox.db.test.js,
 * phase68_ari_channel_delivery.db.test.js): connect to the database AS-IS,
 * seed only two dedicated, randomly-suffixed test tenants, and clean up only
 * the rows this file itself created. No DDL, no schema reset, no migration
 * run — migrations 0001-0091 must already be applied before this file runs.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'db-mode-jwt-secret-at-least-32-characters-long';
  process.env.DATABASE_URL = process.env.DATABASE_URL || URL;

  const { buildStoresDb } = (() => {
    // The persistence module exposes the per-store builders; pick the queue one.
    const mod = require('../../src/channel-manager/persistence/dbStores');
    return { buildStoresDb: mod };
  })();
  const tenantUow = require('../../src/db/tenantUnitOfWork');

  let pool, ctxA, ctxB, queue;

  const withT = (tenantId, fn) => tenantUow.runWithTenantTransaction(pool, tenantId, fn);

  const job = (over = {}) => Object.assign({
    tenant_id: ctxA.tenantId, property_id: ctxA.propertyId,
    reservation_id: 'res-1', action: 'CREATE_BOOKING',
    channel: 'BOOKING_COM', payload: { a: 1 }
  }, over);

  before(async () => {
    pool = H.newPool(URL);
    // Dedicated, randomly-suffixed test tenants — never a fixed code, so a
    // re-run of this file (no schema reset between runs) can never collide
    // with a previous run's leftover rows even if an earlier cleanup was
    // interrupted.
    const suffixA = crypto.randomUUID().slice(0, 8);
    const suffixB = crypto.randomUUID().slice(0, 8);
    ctxA = await H.seedTenantProperty(pool, { code: 'Q66A-' + suffixA, propCode: 'Q66AP-' + suffixA });
    ctxB = await H.seedTenantProperty(pool, { code: 'Q66B-' + suffixB, propCode: 'Q66BP-' + suffixB });
    // The store takes a `db` handle; inside a unit of work we hand it the bound
    // client so every statement runs with app.tenant_id set.
    queue = null;
  });

  after(async () => {
    // Cleanup only the rows THIS file created — no TRUNCATE, no DROP, no
    // broad DELETE. Every table touched is scoped to tenant_id = one of the
    // two tenants seeded above.
    for (const ctx of [ctxA, ctxB]) {
      if (!ctx) continue;
      await H.withTenant(pool, ctx.tenantId, async (c) => {
        await c.query('DELETE FROM channel_sync_queue_store WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM properties WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM tenants WHERE id=$1', [ctx.tenantId]);
      }).catch(() => { /* best-effort cleanup — a failure here must not mask the test's own result */ });
    }
    if (pool) await pool.end();
  });

  function storeOn(client) {
    return buildStoresDb.buildSyncQueueStoreDb
      ? buildStoresDb.buildSyncQueueStoreDb({ db: client })
      : null;
  }

  // -------------------------------------------------------------------------

  // PHASE 68B (instruction 046): this guard originally asserted the 0084-era
  // index name `uq_csqs_pending_channel`. Migration 0086 (Phase 66A-B2M)
  // deliberately DROPPED that index and replaced it with `uq_csqs_active_channel`
  // — same (tenant_id, reservation_id, action, COALESCE(channel,'')) columns,
  // widened predicate from PENDING-only to PENDING+PROCESSING (so a live
  // PROCESSING attempt and a would-be-retry PENDING row for the same logical
  // job can no longer coexist either) — confirmed by direct reading of
  // 0086's own DDL and its own postcondition block (which asserts the exact
  // same shape this test now checks). This is the CURRENT authoritative
  // contract, not a naming accident. Asserted on semantic properties (columns,
  // predicate, uniqueness) rather than the index name alone, per this
  // instruction's own preference, with the name still checked for continuity.
  test('GUARD: the per-channel active-state dedupe key exists with the current (post-0086) contract', async () => {
    const r = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'channel_sync_queue_store' AND indexname LIKE 'uq_csqs%'`);
    const byName = Object.fromEntries(r.rows.map((x) => [x.indexname, x.indexdef]));
    const names = Object.keys(byName);

    assert.ok(!names.includes('uq_csqs_pending'),
      'the original three-column key (0045) must be gone or it will still collapse the fan-out');
    assert.ok(!names.includes('uq_csqs_pending_channel'),
      'the 0084-era PENDING-only per-channel key must be gone — 0086 widened and renamed it');

    const def = byName.uq_csqs_active_channel;
    assert.ok(def, 'the current per-channel active-state key uq_csqs_active_channel must exist, got: ' + names.join(', '));
    assert.match(def, /UNIQUE INDEX/i, 'must be a unique index — non-uniqueness would silently readmit the fan-out bug');
    assert.match(def, /tenant_id/, 'must include tenant_id — a tenant-agnostic key would leak dedupe across tenants');
    assert.match(def, /reservation_id/, 'must include reservation_id');
    assert.match(def, /action/, 'must include action — a different action is a legitimately separate job');
    assert.match(def, /COALESCE\(channel/i, 'must COALESCE(channel, ...) — otherwise two NULL-channel rows are DISTINCT and dedupe silently vanishes');
    assert.match(def, /PENDING/, 'the active-state predicate must cover PENDING');
    assert.match(def, /PROCESSING/, 'the active-state predicate must ALSO cover PROCESSING (0086 widening) — otherwise a live attempt and a pending retry for the same job can coexist');
    assert.ok(!/COMPLETED|FAILED|DEAD_LETTER/.test(def),
      'the active-state predicate must NOT include a terminal status — that would wrongly block a legitimate re-enqueue after completion/failure');
  });

  test('GUARD: the connection role is NON-superuser and NOBYPASSRLS', async () => {
    const r = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    assert.equal(r.rows[0].rolsuper, false);
    assert.equal(r.rows[0].rolbypassrls, false);
  });

  test('C3: one source event persists ONE pending job per enabled channel', async () => {
    const channels = ['BOOKING_COM', 'AGODA', 'EXPEDIA', 'AIRBNB',
                      'MAKEMYTRIP', 'GOOGLE', 'TRIPADVISOR', 'QYRVIA_CONNECT'];
    await withT(ctxA.tenantId, async (client) => {
      const q = storeOn(client);
      for (const channel of channels) {
        const res = await q.enqueue(job({ reservation_id: 'res-fan', channel }));
        assert.equal(res.accepted, true, channel + ' must be accepted');
      }
    });

    const rows = await withT(ctxA.tenantId, async (client) => {
      const r = await client.query(
        `SELECT channel FROM channel_sync_queue_store
          WHERE tenant_id=$1 AND reservation_id='res-fan' AND status='PENDING' ORDER BY channel`,
        [ctxA.tenantId]);
      return r.rows.map((x) => x.channel);
    });
    assert.equal(rows.length, 8, 'all eight channels must survive — the old key kept only one');
    assert.deepEqual(rows.sort(), [...channels].sort());
  });

  test('C3: a duplicate delivery for the SAME channel creates no second pending job', async () => {
    await withT(ctxA.tenantId, async (client) => {
      const q = storeOn(client);
      const first  = await q.enqueue(job({ reservation_id: 'res-dup', channel: 'AGODA' }));
      const second = await q.enqueue(job({ reservation_id: 'res-dup', channel: 'AGODA' }));
      assert.equal(first.accepted, true);
      assert.equal(second.accepted, false);
      assert.equal(second.deduped, true);
    });

    const n = await withT(ctxA.tenantId, async (client) => {
      const r = await client.query(
        `SELECT count(*)::int n FROM channel_sync_queue_store
          WHERE tenant_id=$1 AND reservation_id='res-dup' AND status='PENDING'`, [ctxA.tenantId]);
      return r.rows[0].n;
    });
    assert.equal(n, 1);
  });

  test('C3: a different ACTION for the same reservation+channel is a separate job', async () => {
    await withT(ctxA.tenantId, async (client) => {
      const q = storeOn(client);
      assert.equal((await q.enqueue(job({ reservation_id: 'res-act', action: 'CREATE_BOOKING' }))).accepted, true);
      assert.equal((await q.enqueue(job({ reservation_id: 'res-act', action: 'UPDATE_BOOKING' }))).accepted, true);
    });
    const n = await withT(ctxA.tenantId, async (client) => {
      const r = await client.query(
        `SELECT count(*)::int n FROM channel_sync_queue_store
          WHERE tenant_id=$1 AND reservation_id='res-act' AND status='PENDING'`, [ctxA.tenantId]);
      return r.rows[0].n;
    });
    assert.equal(n, 2);
  });

  test('C3: two tenants with the same reservation id never collide', async () => {
    await withT(ctxA.tenantId, async (client) => {
      const q = storeOn(client);
      assert.equal((await q.enqueue(job({ reservation_id: 'res-shared', channel: 'GOOGLE' }))).accepted, true);
    });
    await withT(ctxB.tenantId, async (client) => {
      const q = storeOn(client);
      const res = await q.enqueue({
        tenant_id: ctxB.tenantId, property_id: ctxB.propertyId,
        reservation_id: 'res-shared', action: 'CREATE_BOOKING',
        channel: 'GOOGLE', payload: {}
      });
      assert.equal(res.accepted, true, 'the key is tenant-scoped');
    });
  });

  test('RLS: tenant B cannot see tenant A queue rows', async () => {
    const seen = await withT(ctxB.tenantId, async (client) => {
      const r = await client.query(
        `SELECT count(*)::int n FROM channel_sync_queue_store WHERE tenant_id = $1`, [ctxA.tenantId]);
      return r.rows[0].n;
    });
    assert.equal(seen, 0, 'cross-tenant queue leak');
  });

  test('C3: a channel-less historical row still dedupes (COALESCE sentinel)', async () => {
    await withT(ctxA.tenantId, async (client) => {
      const q = storeOn(client);
      const a = await q.enqueue(job({ reservation_id: 'res-null', channel: null }));
      const b = await q.enqueue(job({ reservation_id: 'res-null', channel: null }));
      assert.equal(a.accepted, true);
      assert.equal(b.accepted, false,
        'without COALESCE two NULL channels would be DISTINCT and dedupe would vanish');
    });
  });

  test('C3: leaving PENDING frees the key so a later change can re-queue', async () => {
    const id = await withT(ctxA.tenantId, async (client) => {
      const q = storeOn(client);
      const r = await q.enqueue(job({ reservation_id: 'res-free', channel: 'EXPEDIA' }));
      return r.item.id;
    });
    await withT(ctxA.tenantId, async (client) => {
      const q = storeOn(client);
      await q.markCompleted(id);
      const again = await q.enqueue(job({ reservation_id: 'res-free', channel: 'EXPEDIA' }));
      assert.equal(again.accepted, true, 'the partial index only constrains PENDING rows');
    });
  });
}
