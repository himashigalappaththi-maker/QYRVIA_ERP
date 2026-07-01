'use strict';

/**
 * Row-Level Security & append-only enforcement (DB mode) - SINGLE-ROLE model.
 *
 * Connects with the single existing NON-superuser role (TEST_DATABASE_URL =
 * qyrvia_test) - NO superuser, NO CREATE ROLE, NO SET ROLE. After freshSchema()
 * the tenant tables are owned by qyrvia_test, and they carry FORCE ROW LEVEL
 * SECURITY, so RLS binds even to that owner. Isolation is therefore proven on
 * this single role by switching app.tenant_id; cross-tenant read/write is
 * rejected by the policy USING / WITH CHECK.
 *
 * Append-only: the DB-level guarantee is that UPDATE/DELETE are revoked from
 * PUBLIC on the immutable tables (defense in depth alongside the app, which only
 * INSERTs). That revocation is asserted directly; a role-privilege denial on the
 * connecting principal is not meaningful here because qyrvia_test owns the
 * tables (an owner is never denied by a REVOKE FROM PUBLIC).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  let pool, A, B;

  before(async () => {
    pool = H.newPool(URL);
    await H.freshSchema(pool);

    // Seed two tenants. cost_centers carries FORCE RLS, so each insert runs in
    // its own tenant context (its WITH CHECK requires tenant_id = app.tenant_id).
    A = await H.seedTenantProperty(pool, { code: 'TEN-A', propCode: 'PA' });
    B = await H.seedTenantProperty(pool, { code: 'TEN-B', propCode: 'PB' });
    await H.withTenant(pool, A.tenantId, (c) => c.query(
      `INSERT INTO cost_centers (tenant_id, property_id, code, name, type) VALUES
         ($1,$2,'A-ROOM','A Room','ROOM'),
         ($1,$2,'A-FNB','A FnB','FNB')`, [A.tenantId, A.propertyId]));
    await H.withTenant(pool, B.tenantId, (c) => c.query(
      `INSERT INTO cost_centers (tenant_id, property_id, code, name, type) VALUES
         ($1,$2,'B-ROOM','B Room','ROOM')`, [B.tenantId, B.propertyId]));
  });
  after(async () => {
    if (pool) await pool.end();
  });

  test('FORCE RLS binds the (non-superuser) owner: no context => zero rows', async () => {
    // cost_centers has FORCE ROW LEVEL SECURITY and qyrvia_test is the owning
    // role but is NOT a superuser/BYPASSRLS role, so RLS is enforced against it.
    // With no app.tenant_id set the predicate is NULL and no rows are visible.
    const n = await H.withTenant(pool, '', async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers');
      return r.rows[0].n;
    });
    assert.equal(n, 0, 'owner under FORCE RLS sees nothing without a tenant context');
  });

  test('tenant A context sees ONLY tenant A rows', async () => {
    const n = await H.withTenant(pool, A.tenantId, async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers');
      return r.rows[0].n;
    });
    assert.equal(n, 2);
  });

  test('tenant B context sees ONLY tenant B rows', async () => {
    const n = await H.withTenant(pool, B.tenantId, async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers');
      return r.rows[0].n;
    });
    assert.equal(n, 1);
  });

  test('NO tenant context sees ZERO rows', async () => {
    const n = await H.withTenant(pool, '', async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers');
      return r.rows[0].n;
    });
    assert.equal(n, 0, 'NULL app.tenant_id => predicate NULL => no rows');
  });

  test('cross-tenant read leakage blocked (A cannot fetch a B row by id)', async () => {
    const bId = await H.withTenant(pool, B.tenantId, async (c) =>
      (await c.query(`SELECT id FROM cost_centers WHERE code='B-ROOM' LIMIT 1`)).rows[0].id);
    const n = await H.withTenant(pool, A.tenantId, async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers WHERE id=$1', [bId]);
      return r.rows[0].n;
    });
    assert.equal(n, 0);
  });

  test('cross-tenant WRITE blocked - inserting a B row under tenant A context is rejected', async () => {
    // The policy specifies USING with no explicit WITH CHECK, so PostgreSQL
    // applies the USING expression as the WITH CHECK on INSERT: a new row whose
    // tenant_id != app.tenant_id violates the policy (42501).
    await assert.rejects(
      () => H.withTenant(pool, A.tenantId, async (c) => {
        await c.query(
          `INSERT INTO cost_centers (tenant_id, property_id, code, name, type)
           VALUES ($1,$2,'X-LEAK','leak','OTHER')`, [B.tenantId, B.propertyId]);
      }),
      (e) => H.isPgError(e, '42501'));
  });

  test('append-only - UPDATE/DELETE privilege revoked from PUBLIC on immutable tables', async () => {
    for (const t of ['audit_events', 'event_store', 'ledger_entries']) {
      const u = await pool.query(`SELECT has_table_privilege('public', $1, 'UPDATE') AS p`, [t]);
      const d = await pool.query(`SELECT has_table_privilege('public', $1, 'DELETE') AS p`, [t]);
      assert.equal(u.rows[0].p, false, t + ' UPDATE should be revoked from PUBLIC');
      assert.equal(d.rows[0].p, false, t + ' DELETE should be revoked from PUBLIC');
    }
  });
}
