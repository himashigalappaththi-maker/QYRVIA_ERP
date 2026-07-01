'use strict';

/**
 * Phase 30.1 - ARI persistence against REAL PostgreSQL. STRICT data-level boundary
 * (Phase 29): no DDL / no CREATE ROLE / no DROP SCHEMA / no migration at runtime;
 * single existing role (qyrvia_test); tenant-context (FORCE RLS); DELETE cleanup.
 *
 * Validates: computeAri round-trip through the DB store; multi-property isolation;
 * RLS tenant isolation; and concurrency-safe inventory updates (optimistic version
 * + atomic delta).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  const { buildDbAriStore } = require('../../src/ari/store/dbStore');
  const { buildAriService } = require('../../src/ari/ariService');

  let pool, ctx;
  const u = async () => (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
  const withT = (fn) => H.withTenant(pool, ctx.tenantId, fn);

  async function seedTenantProperty() {
    const tid = await u(), pid = await u();
    const code = 'ARI-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    await H.withTenant(pool, tid, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tid, code, code]);
      await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid, tid, code, code, 'LKR']);
    });
    return { tenantId: tid, propertyId: pid };
  }
  const ari = (tenant_id, extra) => Object.assign({ tenant_id, propertyId: ctx.propertyId }, extra);

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regclass('public.ari_inventory_grid') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: ari_inventory_grid missing - migrate the target DB before running');
    ctx = await seedTenantProperty();
  });
  after(async () => {
    if (pool) {
      await H.withTenant(pool, ctx.tenantId, async (c) => {
        for (const t of ['ari_inventory_grid', 'ari_rate_plan', 'ari_room_type', 'ari_restriction_rule', 'ari_rate_rule', 'ari_los_pricing', 'ari_channel_mapping']) {
          await c.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [ctx.tenantId]);
        }
        await c.query('DELETE FROM properties WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM tenants WHERE id=$1', [ctx.tenantId]);
      });
      await pool.end();
    }
  });

  test('computeAri round-trips through the DB store against real PostgreSQL', async () => {
    await withT(async (c) => {
      const store = buildDbAriStore({ db: c });
      await store.putRoomType(ari(ctx.tenantId, { roomTypeId: 'rt', code: 'DLX', name: 'Deluxe', totalUnits: 5 }));
      await store.putRatePlan(ari(ctx.tenantId, { ratePlanId: 'rp', roomTypeId: 'rt', code: 'BAR', baseRate: 100, standardOccupancy: 2, maxOccupancy: 4, extraAdultAmount: 30 }));
      await store.putInventoryCell(ari(ctx.tenantId, { roomTypeId: 'rt', date: '2026-07-01', physical: 5, sold: 1 }));
      await store.putRestrictionRule(ari(ctx.tenantId, { id: 'cta1', level: 'property', date_from: '2026-07-01', date_to: '2026-07-02', cta: true }));
      const out = await buildAriService({ store }).computeAri({ propertyId: ctx.propertyId, dateFrom: '2026-07-01', dateTo: '2026-07-02' });
      assert.equal(out.room_types.length, 1);
      assert.equal(out.room_types[0].availability[0].available, 4);
      assert.equal(out.room_types[0].rate_plans[0].days[0].rate, 100);
      assert.equal(out.room_types[0].rate_plans[0].days[0].restrictions.cta, true);
    });
  });

  test('multi-property isolation: computeAri for one property excludes the other', async () => {
    const pid2 = await u();
    await withT(async (c) => {
      await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid2, ctx.tenantId, 'P2-' + pid2.slice(0, 6), 'P2', 'LKR']);
      const store = buildDbAriStore({ db: c });
      await store.putRoomType({ tenant_id: ctx.tenantId, propertyId: pid2, roomTypeId: 'rt-2', code: 'X', totalUnits: 3 });
      await store.putRatePlan({ tenant_id: ctx.tenantId, propertyId: pid2, ratePlanId: 'rp-2', roomTypeId: 'rt-2', code: 'X', baseRate: 999 });
      const out = await buildAriService({ store }).computeAri({ propertyId: ctx.propertyId, dateFrom: '2026-07-01', dateTo: '2026-07-02' });
      assert.equal(JSON.stringify(out).includes('999'), false);
      assert.equal(out.room_types.every((rt) => rt.room_type_id === 'rt'), true);
    });
  });

  test('RLS: another tenant cannot see this tenant ARI rows', async () => {
    const otherTid = await u();
    // create a throwaway tenant to query under; its context sees none of ctx's rows
    await H.withTenant(pool, otherTid, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [otherTid, 'OTH-' + otherTid.slice(0, 6), 'oth']);
    });
    const rows = await H.withTenant(pool, otherTid, async (c) =>
      (await c.query('SELECT count(*)::int n FROM ari_inventory_grid')).rows[0].n);
    assert.equal(rows, 0, 'RLS hides other tenants ARI inventory');
    await H.withTenant(pool, otherTid, (c) => c.query('DELETE FROM tenants WHERE id=$1', [otherTid]));
  });

  test('concurrency: optimistic version update lets exactly one stale writer win', async () => {
    await withT((c) => buildDbAriStore({ db: c }).putInventoryCell(ari(ctx.tenantId, { roomTypeId: 'rt-opt', date: '2026-07-05', physical: 10, sold: 0 })));
    const upd = (sold) => withT((c) => buildDbAriStore({ db: c }).updateInventoryOptimistic({
      tenant_id: ctx.tenantId, propertyId: ctx.propertyId, roomTypeId: 'rt-opt', date: '2026-07-05', patch: { sold }, expectedVersion: 1
    }));
    const [a, b] = await Promise.all([upd(5), upd(7)]);
    const conflicts = [a, b].filter((r) => r.conflict).length;
    const wins = [a, b].filter((r) => !r.conflict).length;
    assert.equal(wins, 1, 'exactly one optimistic writer won');
    assert.equal(conflicts, 1, 'the stale writer was rejected');
  });

  test('concurrency: atomic adjustSold never loses an update', async () => {
    await withT((c) => buildDbAriStore({ db: c }).putInventoryCell(ari(ctx.tenantId, { roomTypeId: 'rt-atom', date: '2026-07-06', physical: 10, sold: 0 })));
    const bump = () => withT((c) => buildDbAriStore({ db: c }).adjustSold({ tenant_id: ctx.tenantId, propertyId: ctx.propertyId, roomTypeId: 'rt-atom', date: '2026-07-06', delta: 1 }));
    await Promise.all([bump(), bump(), bump()]);
    const sold = await withT((c) => c.query("SELECT sold FROM ari_inventory_grid WHERE tenant_id=$1 AND room_type_id='rt-atom' AND date='2026-07-06'", [ctx.tenantId]).then((r) => r.rows[0].sold));
    assert.equal(sold, 3, 'three concurrent +1 increments all landed (no lost update)');
  });
}
