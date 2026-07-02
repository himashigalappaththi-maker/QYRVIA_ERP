'use strict';

/**
 * RLS preflight gate. Run in CI BEFORE the DB test suite so the pipeline stops
 * immediately on any of:
 *   - the connection is a SUPERUSER or has BYPASSRLS (RLS would be bypassed),
 *   - FORCE ROW LEVEL SECURITY is not set on the core tenant tables,
 *   - PUBLIC still holds UPDATE/DELETE on append-only tables,
 *   - a live cross-tenant data leak (tenant A can see tenant B, or a
 *     cross-tenant INSERT is accepted).
 *
 * Exit code 0 = all guards pass. Exit code 1 = a guard failed (fail the job).
 *
 * Connects ONLY via TEST_DATABASE_URL / DATABASE_URL — no Docker fallback, no
 * temporary cluster, no superuser, no SET ROLE. If no URL is configured it exits
 * 0 (nothing to guard); CI always sets the URL, so the gate always runs there.
 */

const crypto = require('node:crypto');
const H = require('../test/db/_dbHarness');
const G = require('../test/db/_rlsGuard');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;

function fail(msg) { console.error('✖ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('✔ ' + msg); }

async function crossTenantSmoke(pool) {
  const a = await H.seedTenantProperty(pool, { code: 'GUARD-A-' + crypto.randomUUID().slice(0, 8), propCode: 'GA' });
  const b = await H.seedTenantProperty(pool, { code: 'GUARD-B-' + crypto.randomUUID().slice(0, 8), propCode: 'GB' });
  try {
    // (1) tenant A context must NOT see tenant B
    const leaked = await H.withTenant(pool, a.tenantId, (c) =>
      c.query('SELECT count(*)::int n FROM tenants WHERE id = $1', [b.tenantId]).then((r) => r.rows[0].n));
    if (leaked !== 0) fail(`cross-tenant SELECT leaked ${leaked} row(s) — tenant A can read tenant B`);
    else ok('cross-tenant SELECT returns 0 rows');

    // (2) cross-tenant INSERT must be rejected by RLS WITH CHECK (42501)
    let rejected = false;
    try {
      await H.withTenant(pool, b.tenantId, (c) =>
        c.query(`INSERT INTO properties (tenant_id, code, name, currency) VALUES ($1,$2,'leak','LKR')`,
          [a.tenantId, 'GUARD-LEAK-' + crypto.randomUUID().slice(0, 8)]));
    } catch (e) { rejected = H.isPgError(e, '42501'); if (!rejected) throw e; }
    if (rejected) ok('cross-tenant INSERT rejected by RLS WITH CHECK (42501)');
    else fail('cross-tenant INSERT was ACCEPTED — tenant boundary not enforced');
  } finally {
    for (const t of [a, b]) {
      await H.withTenant(pool, t.tenantId, async (c) => {
        await c.query('DELETE FROM properties WHERE tenant_id = $1', [t.tenantId]);
        await c.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]);
      }).catch(() => {});
    }
  }
}

(async () => {
  if (!URL) {
    console.log('RLS preflight: no TEST_DATABASE_URL/DATABASE_URL set — nothing to guard, skipping.');
    return;
  }
  const pool = H.newPool(URL);
  try {
    const info = await G.assertRlsCapableRole(pool);
    ok(`connection role "${info.role}" is non-superuser, non-BYPASSRLS`);
    const n = await G.assertAllTenantTablesSecured(pool);
    ok(`every tenant table (${n}) has ENABLE+FORCE RLS and an app.tenant_id policy`);
    await G.assertNoPublicTableGrants(pool);
    ok('no PUBLIC table privileges in public schema');
    await G.assertAppendOnlyRevoked(pool);
    ok('PUBLIC has no UPDATE/DELETE on append-only tables');
    await crossTenantSmoke(pool);
  } catch (e) {
    fail(e.message);
  } finally {
    await pool.end().catch(() => {});
  }
  if (process.exitCode === 1) {
    console.error('\nRLS preflight FAILED — refusing to run the DB suite under an unsafe configuration.');
  } else {
    console.log('\nRLS preflight passed.');
  }
})();
