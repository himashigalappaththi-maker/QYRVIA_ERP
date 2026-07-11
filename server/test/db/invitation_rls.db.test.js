'use strict';

/**
 * Phase 57 — user_invitations RLS integration tests.
 *
 * Single-role model: connects as qyrvia_test (non-superuser, non-BYPASSRLS).
 * Schema must be migrated (including 0072) before this suite runs.
 * Tests seed their own data and clean up in after().
 *
 * Verifies:
 *   57-I1. Tenant A cannot read tenant B invitation records
 *   57-I2. No tenant GUC → FORCE RLS returns zero rows
 *   57-I3. user_invitations passes assertAllTenantTablesSecured
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const H = require('./_dbHarness');
const G = require('./_rlsGuard');

const URL = H.dbConfig();

if (!URL) {
  test('invitation_rls: DB mode disabled (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {

  let pool;
  const allTenants = [];

  before(async () => {
    pool = H.newPool(URL);
    const check = await pool.query("SELECT to_regclass('public.user_invitations') t");
    assert.ok(check.rows[0].t,
      'user_invitations missing — run migration 0072 before this suite');
  });

  after(async () => {
    if (!pool) return;
    for (const tenantId of allTenants) {
      await H.withTenant(pool, tenantId, async (c) => {
        await c.query('DELETE FROM user_invitations WHERE tenant_id=$1', [tenantId]);
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

  async function insertInvitation(pool, tenantId) {
    const tokenHash = crypto.randomBytes(32).toString('hex');
    const email     = 'inv-' + uid() + '@qyrvia.test';
    await H.withTenant(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO user_invitations
           (tenant_id, email, token_hash, role_codes, property_ids, expires_at)
         VALUES ($1,$2,$3,ARRAY['staff'],ARRAY[]::uuid[],now()+'7 days'::interval)`,
        [tenantId, email, tokenHash]
      );
    });
    return { tokenHash, email };
  }

  // ── Test 57-I1: cross-tenant isolation ──────────────────────────────────────

  test('Phase 57 I1: tenant A cannot read tenant B user_invitations under RLS', async () => {
    const a = await seedTenant('INV-A');
    const b = await seedTenant('INV-B');

    const { tokenHash } = await insertInvitation(pool, a.tenantId);

    const tPoolB = H.tenantBoundPool(URL, b.tenantId);
    try {
      const r = await H.withTenant(tPoolB, b.tenantId, (c) =>
        c.query('SELECT * FROM user_invitations WHERE token_hash=$1', [tokenHash])
      );
      assert.equal(r.rows.length, 0, 'tenant B must not see tenant A invitation records');
    } finally {
      await tPoolB.end();
    }
  });

  // ── Test 57-I2: no GUC → FORCE RLS returns zero rows ────────────────────────

  test('Phase 57 I2: query without app.tenant_id GUC → FORCE RLS returns zero rows', async () => {
    const a = await seedTenant('INV-NOGUC');
    const { tokenHash } = await insertInvitation(pool, a.tenantId);

    // Plain pool: no withTenant call, no app.tenant_id GUC.
    const r = await pool.query(
      'SELECT * FROM user_invitations WHERE token_hash=$1', [tokenHash]
    );
    assert.equal(r.rows.length, 0, 'FORCE RLS must return zero rows when GUC absent');
  });

  // ── Test 57-I3: assertAllTenantTablesSecured covers user_invitations ─────────

  test('Phase 57 I3: user_invitations passes assertAllTenantTablesSecured', async () => {
    const count = await G.assertAllTenantTablesSecured(pool);
    assert.ok(count > 0, 'at least one tenant-scoped table must pass RLS guard');
  });

}
