'use strict';

/**
 * Phase 33 - per-query latency through the PRODUCTION withTenant against REAL
 * PostgreSQL (DB mode). Proves that queries run inside a tenant-scoped
 * transaction record db_queries_total{op=...} + db_query_ms timings in the
 * process-wide observability registry, and that NO SQL text or parameter value
 * leaks into the metric labels or the snapshot.
 *
 * Skips cleanly when TEST_DATABASE_URL is absent (plain `npm test` stays green).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  // The production db/client builds its pool from DATABASE_URL at require time;
  // point it at the test DB BEFORE requiring it.
  process.env.DATABASE_URL = URL;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'db-mode-jwt-secret-at-least-32-characters-long';
  process.env.DB_OBSERVABILITY = 'true';

  const db = require('../../src/db/client');
  const { getObservability } = require('../../src/observability');

  let admin, seeded;

  before(async () => {
    admin = H.newPool(URL);
    await H.freshSchema(admin);
    seeded = await H.seedTenantProperty(admin);
  });

  after(async () => {
    try { await admin.end(); } catch (_) { /* ignore */ }
    try { await db.close(); } catch (_) { /* ignore */ }
  });

  test('withTenant transaction queries record latency without leaking SQL/params', async () => {
    const obs = getObservability();
    obs.reset();

    const SECRET_PARAM = 'no-leak-tenant-' + seeded.tenantId.slice(0, 8);
    const rows = await db.withTenant(seeded.tenantId, async (client) => {
      // A data query inside tenant scope - the instrumented client should time it.
      const r = await client.query('SELECT code, name FROM properties WHERE name <> $1', [SECRET_PARAM]);
      return r.rows;
    });
    assert.ok(Array.isArray(rows));

    const snap = obs.snapshot();

    // op counter + latency histogram recorded for the SELECT.
    assert.ok((snap.counters['db_queries_total{op=select}'] || 0) >= 1, 'expected a select counter');
    const timing = snap.timings['db_query_ms{op=select}'];
    assert.ok(timing && timing.count >= 1, 'expected a db_query_ms timing');

    // A successful RLS context bind was recorded.
    assert.ok((snap.counters['rls_events_total{event=tenant_switch}'] || 0) >= 1);

    // No SQL text, no param value, no tenant id in any metric key.
    const keys = JSON.stringify(Object.keys(snap.counters).concat(Object.keys(snap.timings)));
    assert.ok(!keys.includes(SECRET_PARAM), 'param value leaked into metric labels');
    assert.ok(!keys.includes(seeded.tenantId), 'tenant id leaked into metric labels');
    assert.ok(!keys.includes('FROM properties'), 'raw SQL leaked into metric labels');
  });
}
