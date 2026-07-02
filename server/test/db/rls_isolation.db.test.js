'use strict';

/**
 * RLS tenant isolation against REAL PostgreSQL (DB mode) - SINGLE-ROLE model.
 *
 * STRICT data-level boundary: no DDL, no CREATE ROLE, no DROP SCHEMA, no
 * migration at runtime. The target DB is provisioned + migrated out-of-band and
 * we connect with the single existing NON-superuser role (TEST_DATABASE_URL =
 * qyrvia_test). Because tenants/properties carry FORCE ROW LEVEL SECURITY
 * (migration 0001), RLS binds even to that role, so isolation is proven by DATA
 * OUTCOMES while switching app.tenant_id - NO superuser, NO SET ROLE. The suite
 * removes exactly the rows it seeded (the DB is never reset).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('RLS isolation skipped (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {
  let pool, a, b;
  const uniq = (p) => p + '-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regclass('public.tenants') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: tenants missing - migrate the target DB before running');

    a = await H.seedTenantProperty(pool, { code: uniq('TA'), propCode: uniq('PA') });
    b = await H.seedTenantProperty(pool, { code: uniq('TB'), propCode: uniq('PB') });
  });

  after(async () => {
    if (pool) {
      for (const t of [a, b]) {
        if (!t) continue;
        await H.withTenant(pool, t.tenantId, async (c) => {
          await c.query('DELETE FROM properties WHERE tenant_id = $1', [t.tenantId]);
          await c.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]);
        });
      }
      await pool.end();
    }
  });

  test('tenant A context sees ONLY its own tenant row (RLS visibility baseline)', async () => {
    const n = await H.withTenant(pool, a.tenantId, (c) =>
      c.query('SELECT count(*)::int n FROM tenants WHERE id = $1', [a.tenantId]).then((r) => r.rows[0].n));
    assert.equal(n, 1, 'tenant A must see its own tenant under its context');
  });

  test('tenant A cannot read tenant B data (cross-tenant SELECT blocked)', async () => {
    const rows = await H.withTenant(pool, a.tenantId, (c) =>
      c.query('SELECT * FROM tenants WHERE id = $1', [b.tenantId]).then((r) => r.rows));
    assert.equal(rows.length, 0, 'tenant A context leaked a tenant B row');
  });

  test('no tenant context sees ZERO rows (NULL app.tenant_id => predicate NULL)', async () => {
    const n = await H.withTenant(pool, '', (c) =>
      c.query('SELECT count(*)::int n FROM tenants').then((r) => r.rows[0].n));
    assert.equal(n, 0);
  });

  test('tenant B cannot insert into tenant A scope (RLS WITH CHECK)', async () => {
    // Under tenant B context, create a property owned by tenant A. The properties
    // policy USING (tenant_id = app.tenant_id) is applied as the INSERT WITH
    // CHECK, so tenant_id = A while ctx = B is rejected with 42501 (RLS), not a
    // PK/unique clash.
    await assert.rejects(
      () => H.withTenant(pool, b.tenantId, (c) =>
        c.query(
          `INSERT INTO properties (tenant_id, code, name, currency)
           VALUES ($1, $2, 'hack', 'LKR')`, [a.tenantId, uniq('HACK')])),
      (e) => H.isPgError(e, '42501'));
  });
}
