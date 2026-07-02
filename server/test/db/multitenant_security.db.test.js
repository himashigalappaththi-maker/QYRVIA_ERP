'use strict';

/**
 * Multi-tenant security against REAL PostgreSQL (DB mode) - SINGLE-ROLE model.
 * STRICT data-level boundary: no DDL / no CREATE ROLE / no DROP SCHEMA / no
 * migration / no privilege escalation. RLS is validated by DATA-VISIBILITY
 * OUTCOMES ONLY, connecting with the single existing NON-superuser role
 * (TEST_DATABASE_URL = qyrvia_test) - NO superuser, NO SET ROLE.
 *
 * The channel tables use FORCE ROW LEVEL SECURITY, so RLS binds even to the
 * (non-superuser) owner role. Isolation is proven on that single role by
 * switching app.tenant_id.
 *
 * FINDING (documented, not a defect): RLS is TENANT-grain by design (one DB per
 * on-prem install). Property isolation is application-level (explicit WHERE
 * property_id), NOT RLS - a tenant context sees every property within its tenant.
 *
 * All assertions are scoped to THIS run's tenant ids; the DB is not reset.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  let pool, A, B, PA2;
  const u = async () => (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;

  async function seedTenant(prefix) {
    const tid = await u(), pid = await u();
    const code = prefix + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    await H.withTenant(pool, tid, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tid, code, code]);
      await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid, tid, code, code, 'LKR']);
    });
    return { tenantId: tid, propertyId: pid, code };
  }
  async function addProperty(tid, code) {
    const pid = await u();
    await H.withTenant(pool, tid, (c) =>
      c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid, tid, code, code, 'LKR']));
    return pid;
  }
  async function seedJob(tid, pid, resId) {
    await H.withTenant(pool, tid, (c) =>
      c.query(`INSERT INTO channel_sync_queue_store (tenant_id, property_id, reservation_id, action, channel)
               VALUES ($1,$2,$3,'CREATE_BOOKING','BOOKING_COM')`, [tid, pid, resId]));
  }
  // visible row count for a given app.tenant_id context (RLS outcome)
  const visible = (tenantCtx) => H.withTenant(pool, tenantCtx, (c) =>
    c.query('SELECT count(*)::int n FROM channel_sync_queue_store').then((r) => r.rows[0].n));

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regclass('public.channel_sync_queue_store') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: channel_sync_queue_store missing - migrate the target DB before running');
    A = await seedTenant('SEC-A');
    B = await seedTenant('SEC-B');
    PA2 = await addProperty(A.tenantId, A.code + '-P2');   // second property under tenant A
    await seedJob(A.tenantId, A.propertyId, 'A-R1');
    await seedJob(A.tenantId, PA2,          'A-R2');         // tenant A, second property
    await seedJob(B.tenantId, B.propertyId, 'B-R1');
  });
  after(async () => {
    if (pool) {
      for (const t of [A, B]) {
        if (!t) continue;
        await H.withTenant(pool, t.tenantId, async (c) => {
          await c.query('DELETE FROM channel_sync_queue_store WHERE tenant_id=$1', [t.tenantId]);
          await c.query('DELETE FROM properties WHERE tenant_id=$1', [t.tenantId]);
          await c.query('DELETE FROM tenants WHERE id=$1', [t.tenantId]);
        });
      }
      await pool.end();
    }
  });

  test('tenant A context sees ONLY tenant A rows (RLS visibility)', async () => {
    assert.equal(await visible(A.tenantId), 2);   // both A properties, none of B
  });

  test('tenant B context sees ONLY tenant B rows', async () => {
    assert.equal(await visible(B.tenantId), 1);
  });

  test('NO tenant context sees ZERO rows', async () => {
    assert.equal(await visible(''), 0);
  });

  test('cross-tenant read by id is blocked (A cannot see a B job row)', async () => {
    const bId = await H.withTenant(pool, B.tenantId, (c) =>
      c.query("SELECT id FROM channel_sync_queue_store WHERE reservation_id='B-R1'").then((r) => r.rows[0].id));
    const n = await H.withTenant(pool, A.tenantId, (c) =>
      c.query('SELECT count(*)::int n FROM channel_sync_queue_store WHERE id=$1', [bId]).then((r) => r.rows[0].n));
    assert.equal(n, 0);
  });

  test('cross-tenant WRITE is rejected (insert a B-tenant row under A context)', async () => {
    await assert.rejects(
      () => H.withTenant(pool, A.tenantId, (c) =>
        c.query(`INSERT INTO channel_sync_queue_store (tenant_id, property_id, reservation_id, action)
                 VALUES ($1,$2,'LEAK','CREATE_BOOKING')`, [B.tenantId, B.propertyId])),
      (e) => H.isPgError(e, '42501'));   // RLS WITH CHECK violation
  });

  test('tenant-escape attempt: a forged/garbage app.tenant_id yields ZERO rows (no bypass)', async () => {
    for (const forged of ['00000000-0000-0000-0000-000000000000', "x' OR '1'='1"]) {
      assert.equal(await visible(forged), 0, 'forged tenant id ' + JSON.stringify(forged) + ' leaked rows');
    }
  });

  test('FINDING: RLS is tenant-grain - a tenant context sees ALL its properties (cross-property is app-level)', async () => {
    const props = await H.withTenant(pool, A.tenantId, (c) =>
      c.query('SELECT DISTINCT property_id FROM channel_sync_queue_store ORDER BY property_id').then((r) => r.rows.map((x) => x.property_id)));
    assert.equal(props.length, 2, 'tenant A context sees rows from BOTH its properties (RLS does not isolate by property)');
    assert.ok(props.includes(A.propertyId) && props.includes(PA2));
  });
}
