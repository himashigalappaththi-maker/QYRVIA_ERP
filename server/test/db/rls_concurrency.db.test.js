'use strict';

/**
 * RLS concurrency / connection-reuse safety (DB mode) - SINGLE-ROLE model.
 *
 * Tenant context is set transaction-locally (`set_config('app.tenant_id',$1,true)`)
 * so it MUST reset on COMMIT/ROLLBACK and never bleed to the next checkout of a
 * pooled connection. This suite proves that under heavy reuse: a deliberately
 * tiny pool is hammered with many interleaved tenant + no-context queries, each
 * tenant seeded with a DISTINCT row count, so any GUC leakage across reuse shows
 * up immediately as a wrong count. Connects as the NON-superuser qyrvia_test.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('RLS concurrency skipped (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {
  const N = 8;          // tenants, each with a distinct audit_events count
  const OPS = 240;      // interleaved operations
  let pool, tenants;

  before(async () => {
    pool = H.newPool(URL, { max: 3 });   // tiny pool => connections reused across tenants
    tenants = [];
    for (let i = 0; i < N; i++) {
      const tenantId = crypto.randomUUID();
      const count = 13 + i * 4;          // distinct per tenant: 13,17,21,...
      tenants.push({ tenantId, count });
      await H.withTenant(pool, tenantId, async (c) => {
        await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)',
          [tenantId, 'CONC-' + i + '-' + tenantId.slice(0, 8), 'conc']);
        await c.query(`INSERT INTO audit_events (tenant_id, event_type, aggregate_type, aggregate_id)
                       SELECT $1,'conc_test','agg',gen_random_uuid()::text FROM generate_series(1,$2)`,
          [tenantId, count]);
      });
    }
  });

  after(async () => {
    if (pool) {
      for (const t of tenants || []) {
        await H.withTenant(pool, t.tenantId, async (c) => {
          await c.query("DELETE FROM audit_events WHERE tenant_id=$1 AND event_type='conc_test'", [t.tenantId]);
          await c.query('DELETE FROM tenants WHERE id=$1', [t.tenantId]);
        }).catch(() => {});
      }
      await pool.end();
    }
  });

  test('no GUC contamination under heavy pool reuse (each tenant sees only its own rows)', async () => {
    const countFor = (tenantCtx) => H.withTenant(pool, tenantCtx, (c) =>
      c.query("SELECT count(*)::int n FROM audit_events WHERE event_type='conc_test'").then((r) => r.rows[0].n));

    const tasks = [];
    for (let k = 0; k < OPS; k++) {
      if (k % 6 === 0) {
        // no-context query MUST see 0 (context must not bleed from a prior tx)
        tasks.push(countFor('').then((n) => assert.equal(n, 0, 'no-context leaked ' + n + ' rows')));
      } else {
        const t = tenants[k % N];
        tasks.push(countFor(t.tenantId).then((n) =>
          assert.equal(n, t.count, `tenant expected ${t.count} but saw ${n} (GUC leak)`)));
      }
    }
    await Promise.all(tasks);
  });

  test('a forged/garbage app.tenant_id yields 0 rows (safe cast, no error) even under reuse', async () => {
    const tasks = [];
    for (const forged of ['00000000-0000-0000-0000-000000000000', "x' OR '1'='1", 'not-a-uuid']) {
      for (let k = 0; k < 10; k++) {
        tasks.push(H.withTenant(pool, forged, (c) =>
          c.query("SELECT count(*)::int n FROM audit_events WHERE event_type='conc_test'").then((r) =>
            assert.equal(r.rows[0].n, 0, 'forged ctx ' + JSON.stringify(forged) + ' leaked'))));
      }
    }
    await Promise.all(tasks);
  });
}
