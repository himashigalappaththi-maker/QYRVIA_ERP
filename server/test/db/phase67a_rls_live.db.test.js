'use strict';

/**
 * Phase 67A Workstream A — LIVE RLS verification against a real PostgreSQL
 * database (migration 0090 applied).
 *
 * NOT RUN as part of this Phase 67A safety pass. Per the brief's Section 11
 * (TEST EXECUTION SAFETY): no PostgreSQL connection may be opened, no
 * server/.env read, no migrations/bootstraps/psql/Docker DB commands may be
 * run in this session. This file is created to close the coverage gap for
 * later verification against a separately provisioned, verified
 * `qyrvia_test` database — it is intentionally left UNRUN here.
 *
 *   RLS_STATIC_AND_CONTRACT_VERIFIED = true  (phase67a_migration_0090_contract.test.js)
 *   RLS_LIVE_DATABASE_VERIFIED       = false (THIS file — not executed this pass)
 *
 * To run later, once a verified qyrvia_test database + TEST_DATABASE_URL are
 * available:  npm run test:db  (or  node --test test/db/phase67a_rls_live.db.test.js)
 *
 * Follows the exact self-gating pattern used throughout test/db/*.db.test.js
 * (see invitation_rls.db.test.js): the suite no-ops with a single skipped
 * test when TEST_DATABASE_URL is not set, so it is safe to exist in the repo
 * without accidentally running against a real database.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const H = require('./_dbHarness');
const G = require('./_rlsGuard');

const URL = H.dbConfig();

if (!URL) {
  test('phase67a_rls_live: DB mode disabled (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {

  let pool;
  const allTenants = [];

  before(async () => {
    pool = H.newPool(URL);
    await G.assertRlsCapableRole(pool); // never validate RLS on a superuser/BYPASSRLS connection
  });

  after(async () => {
    if (!pool) return;
    for (const tenantId of allTenants) {
      await H.withTenant(pool, tenantId, async (c) => {
        await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
      }).catch(() => {});
    }
    await pool.end();
  });

  function uid() { return crypto.randomBytes(3).toString('hex'); }

  async function seedTenant(label) {
    const t = await H.seedTenantProperty(pool, { code: label + '-' + uid(), propCode: 'P-' + uid() });
    allTenants.push(t.tenantId);
    return t;
  }

  // ── Postcondition parity: the migration's own guarantee, re-checked live ──

  test('Phase 67A: every tenant-scoped table has ENABLE+FORCE RLS and an app.tenant_id-bound policy', async () => {
    const count = await G.assertAllTenantTablesSecured(pool);
    assert.ok(count > 0, 'at least one tenant-scoped table must be checked');
  });

  // ── channel_registry: the one policy this migration actually rewrites ─────

  test('Phase 67A: channel_registry has FORCE RLS and an explicit, sargable WITH CHECK', async () => {
    const r = await pool.query(`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='channel_registry'`);
    assert.equal(r.rows.length, 1, 'channel_registry table not found — is the schema migrated?');
    assert.equal(r.rows[0].enabled, true);
    assert.equal(r.rows[0].forced, true);

    const p = await pool.query(`
      SELECT policyname, qual, with_check FROM pg_policies
       WHERE schemaname='public' AND tablename='channel_registry'
         AND policyname='channel_registry_tenant_isolation'`);
    assert.equal(p.rows.length, 1, 'channel_registry_tenant_isolation policy missing');
    assert.ok(p.rows[0].with_check, 'policy must have an EXPLICIT WITH CHECK clause (migration 0090 fix)');
    assert.match(p.rows[0].with_check, /tenant_id\s*=\s*app_current_tenant\(\)/);
    assert.match(p.rows[0].qual, /tenant_id\s*=\s*app_current_tenant\(\)/);
  });

  // ── No table with tenant_id lacks FORCE (independent re-check of the
  //    migration's own RAISE EXCEPTION postcondition) ────────────────────────

  test('Phase 67A: no table with a tenant_id column lacks FORCE ROW LEVEL SECURITY', async () => {
    const r = await pool.query(`
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                     WHERE col.table_schema='public' AND col.table_name=c.relname
                       AND col.column_name='tenant_id')
         AND (c.relrowsecurity IS NOT TRUE OR c.relforcerowsecurity IS NOT TRUE)`);
    assert.deepEqual(r.rows.map((x) => x.relname), [],
      'these tenant-scoped tables lack ENABLE+FORCE RLS');
  });

  // ── Cross-tenant isolation spot check on a representative table ───────────

  test('Phase 67A: cross-tenant isolation still holds post-migration (properties)', async () => {
    const a = await seedTenant('P67A-A');
    const b = await seedTenant('P67A-B');

    const tPoolB = H.tenantBoundPool(URL, b.tenantId);
    try {
      const r = await H.withTenant(tPoolB, b.tenantId, (c) =>
        c.query('SELECT * FROM properties WHERE id=$1', [a.propertyId])
      );
      assert.equal(r.rows.length, 0, 'tenant B must not see tenant A\'s property row');
    } finally {
      await tPoolB.end();
    }
  });

  // ── No GUC -> FORCE RLS returns zero rows, even for the app's own role ────

  test('Phase 67A: query without app.tenant_id GUC returns zero rows (FORCE RLS, not just ENABLE)', async () => {
    const a = await seedTenant('P67A-NOGUC');
    // Plain pool query: no withTenant call, no app.tenant_id GUC set.
    const r = await pool.query('SELECT * FROM properties WHERE id=$1', [a.propertyId]);
    assert.equal(r.rows.length, 0, 'FORCE RLS must return zero rows when the GUC is absent, even for the owning role');
  });

}
