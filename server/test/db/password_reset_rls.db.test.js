'use strict';

/**
 * Phase 57 — password_reset_tokens RLS integration tests.
 *
 * Single-role model: connects as qyrvia_test (non-superuser, non-BYPASSRLS).
 * Schema must be migrated (including 0073) before this suite runs.
 * Tests seed their own data and clean up in after().
 *
 * Verifies:
 *   57-R1. Tenant A cannot read tenant B password_reset_tokens
 *   57-R2. No tenant GUC → FORCE RLS returns zero rows
 *   57-R3. password_reset_tokens passes assertAllTenantTablesSecured
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const H = require('./_dbHarness');
const G = require('./_rlsGuard');

const URL = H.dbConfig();

if (!URL) {
  test('password_reset_rls: DB mode disabled (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {

  let pool;
  const allTenants = [];
  const allUsers   = [];

  before(async () => {
    pool = H.newPool(URL);
    const check = await pool.query("SELECT to_regclass('public.password_reset_tokens') t");
    assert.ok(check.rows[0].t,
      'password_reset_tokens missing — run migration 0073 before this suite');
  });

  after(async () => {
    if (!pool) return;
    for (const tenantId of allTenants) {
      await H.withTenant(pool, tenantId, async (c) => {
        await c.query('DELETE FROM password_reset_tokens WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM users WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM properties WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
      }).catch(() => {});
    }
    await pool.end();
  });

  function uid() { return crypto.randomBytes(3).toString('hex'); }

  async function seedTenantWithUser(label) {
    const t = await H.seedTenantProperty(pool, { code: label + '-' + uid(), propCode: 'P-' + uid() });
    allTenants.push(t.tenantId);

    const userId = crypto.randomUUID();
    allUsers.push(userId);
    await H.withTenant(pool, t.tenantId, async (c) => {
      await c.query(
        `INSERT INTO users (id, tenant_id, username, email, password_hash, full_name, status)
         VALUES ($1,$2,$3,$4,'$2b$10$placeholder','RLS Test User','ACTIVE')`,
        [userId, t.tenantId, 'rls-test-' + uid(), 'rls-' + uid() + '@qyrvia.test']
      );
    });
    return { ...t, userId };
  }

  async function insertResetToken(pool, tenantId, userId) {
    const tokenHash = crypto.randomBytes(32).toString('hex');
    await H.withTenant(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO password_reset_tokens (user_id, tenant_id, token_hash, expires_at)
         VALUES ($1,$2,$3,now()+'1 hour'::interval)`,
        [userId, tenantId, tokenHash]
      );
    });
    return { tokenHash };
  }

  // ── Test 57-R1: cross-tenant isolation ──────────────────────────────────────

  test('Phase 57 R1: tenant A cannot read tenant B password_reset_tokens under RLS', async () => {
    const a = await seedTenantWithUser('RST-A');
    const b = await seedTenantWithUser('RST-B');

    const { tokenHash } = await insertResetToken(pool, a.tenantId, a.userId);

    const tPoolB = H.tenantBoundPool(URL, b.tenantId);
    try {
      const r = await H.withTenant(tPoolB, b.tenantId, (c) =>
        c.query('SELECT * FROM password_reset_tokens WHERE token_hash=$1', [tokenHash])
      );
      assert.equal(r.rows.length, 0, 'tenant B must not see tenant A reset tokens');
    } finally {
      await tPoolB.end();
    }
  });

  // ── Test 57-R2: no GUC → FORCE RLS returns zero rows ────────────────────────

  test('Phase 57 R2: query without app.tenant_id GUC → FORCE RLS returns zero rows', async () => {
    const a = await seedTenantWithUser('RST-NOGUC');
    const { tokenHash } = await insertResetToken(pool, a.tenantId, a.userId);

    // Plain pool: no withTenant call, no GUC.
    const r = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token_hash=$1', [tokenHash]
    );
    assert.equal(r.rows.length, 0, 'FORCE RLS must return zero rows when GUC absent');
  });

  // ── Test 57-R3: assertAllTenantTablesSecured covers password_reset_tokens ────

  test('Phase 57 R3: password_reset_tokens passes assertAllTenantTablesSecured', async () => {
    const count = await G.assertAllTenantTablesSecured(pool);
    assert.ok(count > 0, 'at least one tenant-scoped table must pass RLS guard');
  });

}
