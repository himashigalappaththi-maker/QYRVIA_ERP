'use strict';

/**
 * Phase 9.1 - Row-Level Security & append-only enforcement (DB mode).
 *
 * RLS only binds to a NON-superuser, NON-BYPASSRLS role. The production app
 * currently connects as the DB owner via a single pool that does NOT set
 * `app.tenant_id` on its repo queries (see db/repos.js + db/client.js), so in
 * production RLS is effectively bypassed and isolation rests on the explicit
 * `WHERE tenant_id = $1` in every repo. These tests prove what the DB *would*
 * enforce under a correctly-scoped role, and document the gap.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  let admin, restricted, A, B;

  before(async () => {
    admin = H.newPool(URL);
    await H.freshSchema(admin);
    const role = await H.setupAppRole(admin);
    restricted = H.newPool(H.roleUrl(URL, role.role, role.password));

    // Seed two tenants as the owner (RLS bypassed for superuser/owner).
    A = await H.seedTenantProperty(admin, { code: 'TEN-A', propCode: 'PA' });
    B = await H.seedTenantProperty(admin, { code: 'TEN-B', propCode: 'PB' });
    await admin.query(
      `INSERT INTO cost_centers (tenant_id, property_id, code, name, type) VALUES
         ($1,$2,'A-ROOM','A Room','ROOM'),
         ($1,$2,'A-FNB','A FnB','FNB')`, [A.tenantId, A.propertyId]);
    await admin.query(
      `INSERT INTO cost_centers (tenant_id, property_id, code, name, type) VALUES
         ($1,$2,'B-ROOM','B Room','ROOM')`, [B.tenantId, B.propertyId]);
  });
  after(async () => {
    if (restricted) await restricted.end();
    if (admin) await admin.end();
  });

  test('superuser/owner connection BYPASSES RLS (documents production gap)', async () => {
    // No app.tenant_id set; owner sees ALL tenants' rows.
    const r = await admin.query('SELECT count(*)::int n FROM cost_centers');
    assert.equal(r.rows[0].n, 3, 'owner sees every tenant (RLS bypassed)');
  });

  test('restricted role with tenant A context sees ONLY tenant A rows', async () => {
    const rows = await H.withTenant(restricted, A.tenantId, async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers');
      return r.rows[0].n;
    });
    assert.equal(rows, 2);
  });

  test('restricted role with tenant B context sees ONLY tenant B rows', async () => {
    const n = await H.withTenant(restricted, B.tenantId, async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers');
      return r.rows[0].n;
    });
    assert.equal(n, 1);
  });

  test('restricted role with NO tenant context sees ZERO rows', async () => {
    const n = await H.withTenant(restricted, '', async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers');
      return r.rows[0].n;
    });
    assert.equal(n, 0, 'NULL app.tenant_id => predicate NULL => no rows');
  });

  test('cross-tenant read leakage blocked (A cannot fetch a B row by id)', async () => {
    const bId = (await admin.query(
      `SELECT id FROM cost_centers WHERE code='B-ROOM' LIMIT 1`)).rows[0].id;
    const n = await H.withTenant(restricted, A.tenantId, async (c) => {
      const r = await c.query('SELECT count(*)::int n FROM cost_centers WHERE id=$1', [bId]);
      return r.rows[0].n;
    });
    assert.equal(n, 0);
  });

  test('cross-tenant WRITE blocked - inserting a B row under tenant A context is rejected', async () => {
    // These policies specify USING with no explicit WITH CHECK, so PostgreSQL
    // applies the USING expression as the WITH CHECK on INSERT: a new row whose
    // tenant_id != app.tenant_id violates the policy.
    await assert.rejects(
      () => H.withTenant(restricted, A.tenantId, async (c) => {
        await c.query(
          `INSERT INTO cost_centers (tenant_id, property_id, code, name, type)
           VALUES ($1,$2,'X-LEAK','leak','OTHER')`, [B.tenantId, B.propertyId]);
      }),
      (e) => H.isPgError(e, '42501'));   // insufficient_privilege / RLS violation
  });

  test('append-only - restricted role cannot UPDATE or DELETE audit_events', async () => {
    // Insert one audit row as owner to target.
    await admin.query(
      `INSERT INTO audit_events (event_type, aggregate_type, aggregate_id, tenant_id, payload)
       VALUES ('test.event','t','x',$1,'{}'::jsonb)`, [A.tenantId]);
    await assert.rejects(
      () => H.withTenant(restricted, A.tenantId, (c) =>
        c.query(`UPDATE audit_events SET event_type='hacked' WHERE tenant_id=$1`, [A.tenantId])),
      (e) => H.isPgError(e, '42501'));
    await assert.rejects(
      () => H.withTenant(restricted, A.tenantId, (c) =>
        c.query(`DELETE FROM audit_events WHERE tenant_id=$1`, [A.tenantId])),
      (e) => H.isPgError(e, '42501'));
  });

  test('append-only privilege revoked from PUBLIC on audit_events + event_store', async () => {
    for (const t of ['audit_events', 'event_store', 'ledger_entries']) {
      const u = await admin.query(`SELECT has_table_privilege('public', $1, 'UPDATE') AS p`, [t]);
      const d = await admin.query(`SELECT has_table_privilege('public', $1, 'DELETE') AS p`, [t]);
      assert.equal(u.rows[0].p, false, t + ' UPDATE should be revoked from PUBLIC');
      assert.equal(d.rows[0].p, false, t + ' DELETE should be revoked from PUBLIC');
    }
  });
}
