'use strict';

/**
 * Phase 31.5 - Multi-property isolation against REAL PostgreSQL (DB mode),
 * SINGLE-ROLE model (TEST_DATABASE_URL = qyrvia_test; no superuser, no SET ROLE).
 *
 * Confirms the architecture: RLS is at the COMPANY (tenant) level; PROPERTY
 * isolation is application-level (explicit WHERE property_id) and is NOT RLS.
 * Also proves every row carries the audit quad (tenant, property, user, time)
 * and that one tenant can never see another tenant's property rows (RLS).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('property isolation skipped (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {
  let pool, A, B;          // A,B = two companies (tenants)

  async function seedCompany(prefix) {
    const tenantId = crypto.randomUUID();
    const p1 = crypto.randomUUID(), p2 = crypto.randomUUID(), user = crypto.randomUUID();
    await H.withTenant(pool, tenantId, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tenantId, prefix + '-' + tenantId.slice(0, 8), prefix]);
      for (const [pid, code] of [[p1, 'PA'], [p2, 'PB']]) {
        await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid, tenantId, prefix + '-' + code, code, 'LKR']);
      }
      // audit rows: 3 for property 1, 2 for property 2 - each with the full quad
      const rows = [[p1, 3], [p2, 2]];
      for (const [pid, n] of rows) {
        await c.query(`INSERT INTO audit_events (tenant_id, property_id, actor_id, event_type, aggregate_type, aggregate_id, occurred_at)
                       SELECT $1,$2,$3,'prop.test','agg',gen_random_uuid()::text, now() FROM generate_series(1,$4)`,
          [tenantId, pid, user, n]);
      }
    });
    return { tenantId, p1, p2, user };
  }

  before(async () => {
    pool = H.newPool(URL);
    A = await seedCompany('PROP-A');
    B = await seedCompany('PROP-B');
  });
  after(async () => {
    if (pool) {
      for (const t of [A, B]) {
        if (!t) continue;
        await H.withTenant(pool, t.tenantId, async (c) => {
          await c.query("DELETE FROM audit_events WHERE tenant_id=$1 AND event_type='prop.test'", [t.tenantId]);
          await c.query('DELETE FROM properties WHERE tenant_id=$1', [t.tenantId]);
          await c.query('DELETE FROM tenants WHERE id=$1', [t.tenantId]);
        }).catch(() => {});
      }
      await pool.end();
    }
  });

  const countWhere = (tenantCtx, sql, params) => H.withTenant(pool, tenantCtx, (c) =>
    c.query(sql, params).then((r) => r.rows[0].n));

  test('RLS is tenant-grain: a company context sees ALL its properties rows', async () => {
    const n = await countWhere(A.tenantId, "SELECT count(*)::int n FROM audit_events WHERE event_type='prop.test'");
    assert.equal(n, 5, 'company A sees both its properties (3+2)');
  });

  test('property isolation is application-level: explicit property_id filter scopes the rows', async () => {
    const n1 = await countWhere(A.tenantId, "SELECT count(*)::int n FROM audit_events WHERE event_type='prop.test' AND property_id=$1", [A.p1]);
    const n2 = await countWhere(A.tenantId, "SELECT count(*)::int n FROM audit_events WHERE event_type='prop.test' AND property_id=$1", [A.p2]);
    assert.equal(n1, 3);
    assert.equal(n2, 2);
  });

  test('every audit row carries the full quad (tenant_id, property_id, actor_id/user, occurred_at)', async () => {
    const bad = await countWhere(A.tenantId,
      "SELECT count(*)::int n FROM audit_events WHERE event_type='prop.test' AND (tenant_id IS NULL OR property_id IS NULL OR actor_id IS NULL OR occurred_at IS NULL)");
    assert.equal(bad, 0, 'no audit row missing any of tenant/property/user/timestamp');
  });

  test('cross-tenant property never leaks: company A cannot see company B property rows even by id', async () => {
    const n = await countWhere(A.tenantId, "SELECT count(*)::int n FROM audit_events WHERE property_id=$1", [B.p1]);
    assert.equal(n, 0, 'RLS blocks another tenant property even with an explicit property_id filter');
  });

  test('cross-property within a tenant is reachable only by explicit context (no implicit default)', async () => {
    // Querying a property the caller did not scope to returns that property's rows
    // ONLY because the app explicitly asked for it - the DB never auto-scopes by property.
    const nDefault = await countWhere(A.tenantId, "SELECT count(*)::int n FROM audit_events WHERE event_type='prop.test'");
    const nP1 = await countWhere(A.tenantId, "SELECT count(*)::int n FROM audit_events WHERE event_type='prop.test' AND property_id=$1", [A.p1]);
    assert.ok(nDefault > nP1, 'without an explicit property filter the tenant sees more than one property (property scope is app-level)');
  });
}
