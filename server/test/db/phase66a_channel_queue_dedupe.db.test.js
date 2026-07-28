'use strict';

/**
 * Phase 66A C3 — per-channel queue dedupe against REAL PostgreSQL.
 *
 * Migration 0084 replaces uq_csqs_pending — which was
 * (tenant_id, reservation_id, action) WHERE status='PENDING' — with a key that
 * also includes the channel. Without that change, one PMS event fanning out to
 * eight OTAs produces eight INSERTs that all conflict onto a single row, and
 * seven channels are silently dropped with no error anywhere.
 *
 * These tests drive the REAL persistence store, inside the Phase 64 tenant unit
 * of work, under FORCE ROW LEVEL SECURITY.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
    const ddl = H.newPool(URL);
    try {
      await H.freshSchema(ddl);
      ctxA = await H.seedTenantProperty(ddl, { code: 'Q66A', propCode: 'Q66AP' });
      ctxB = await H.seedTenantProperty(ddl, { code: 'Q66B', propCode: 'Q66BP' });
    } finally { await ddl.end(); }

    pool = H.newPool(URL);
    // The store takes a `db` handle; inside a unit of work we hand it the bound
    // client so every statement runs with app.tenant_id set.
    queue = null;
  });

  after(async () => { if (pool) await pool.end(); });

  function storeOn(client) {
    return buildStoresDb.buildSyncQueueStoreDb
      ? buildStoresDb.buildSyncQueueStoreDb({ db: client })
      : null;
  }

  // -------------------------------------------------------------------------

  test('GUARD: migration 0084 applied — the old index is gone, the new one exists', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'channel_sync_queue_store' AND indexname LIKE 'uq_csqs%'`);
    const names = r.rows.map((x) => x.indexname);
    assert.ok(names.includes('uq_csqs_pending_channel'),
      'the per-channel key must exist, got: ' + names.join(', '));
    assert.ok(!names.includes('uq_csqs_pending'),
      'the old three-column key must be gone or it will still collapse the fan-out');
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
