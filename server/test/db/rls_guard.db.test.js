'use strict';

/**
 * RLS GUARD (DB mode) - first-class enforcement that the DB test principal is
 * RLS-capable and that tenant isolation holds. If this file fails, the DB suite
 * fails, so a regression to superuser-based testing or a tenant leak cannot pass
 * CI. Single-role model: connects as the existing NON-superuser role
 * (TEST_DATABASE_URL = qyrvia_test); NO superuser, NO SET ROLE, NO CREATE ROLE.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');
const G = require('./_rlsGuard');

const URL = H.dbConfig();

if (!URL) {
  test('RLS guard skipped (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {
  let pool, a, b;

  before(async () => {
    pool = H.newPool(URL);
    a = await H.seedTenantProperty(pool, { code: 'GRD-A-' + crypto.randomUUID().slice(0, 8), propCode: 'GA' });
    b = await H.seedTenantProperty(pool, { code: 'GRD-B-' + crypto.randomUUID().slice(0, 8), propCode: 'GB' });
  });
  after(async () => {
    if (pool) {
      for (const t of [a, b]) {
        if (!t) continue;
        await H.withTenant(pool, t.tenantId, async (c) => {
          await c.query('DELETE FROM properties WHERE tenant_id = $1', [t.tenantId]);
          await c.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]);
        }).catch(() => {});
      }
      await pool.end();
    }
  });

  test('GUARD: connection role is NON-superuser and NON-BYPASSRLS', async () => {
    const info = await G.assertRlsCapableRole(pool);   // throws on superuser/bypassrls
    assert.equal(info.is_superuser, false);
    assert.equal(info.bypassrls, false);
  });

  test('GUARD: EVERY tenant-scoped table has ENABLE+FORCE RLS and an app.tenant_id policy', async () => {
    const n = await G.assertAllTenantTablesSecured(pool);   // throws on ANY gap
    assert.ok(n > 0, 'expected tenant tables to be present');
  });

  test('GUARD: no PUBLIC table privileges (no accidental world access)', async () => {
    await G.assertNoPublicTableGrants(pool);   // throws if PUBLIC holds any table grant
  });

  test('GUARD: cross-tenant SELECT returns 0 rows', async () => {
    const n = await H.withTenant(pool, a.tenantId, (c) =>
      c.query('SELECT count(*)::int n FROM tenants WHERE id = $1', [b.tenantId]).then((r) => r.rows[0].n));
    assert.equal(n, 0, 'tenant A leaked a tenant B row');
  });

  test('GUARD: cross-tenant INSERT respects tenant boundary (rejected 42501)', async () => {
    await assert.rejects(
      () => H.withTenant(pool, b.tenantId, (c) =>
        c.query(`INSERT INTO properties (tenant_id, code, name, currency) VALUES ($1,$2,'leak','LKR')`,
          [a.tenantId, 'GRD-LEAK-' + crypto.randomUUID().slice(0, 8)])),
      (e) => H.isPgError(e, '42501'));
  });

  test('GUARD: no privilege leak via PUBLIC on append-only tables', async () => {
    await G.assertAppendOnlyRevoked(pool);   // throws if PUBLIC has UPDATE/DELETE
  });
}
