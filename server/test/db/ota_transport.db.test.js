'use strict';

/**
 * Phase 30.2 - OTA transport persistence against REAL PostgreSQL. STRICT data-level
 * boundary (Phase 29): no DDL / no CREATE ROLE / no DROP SCHEMA / no migration at
 * runtime; single existing role (qyrvia_test); tenant-context (FORCE RLS); DELETE
 * cleanup. Validates idempotent sync-attempt recording, drift persistence, health
 * upsert, metrics aggregation, and RLS tenant isolation.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  const { buildOtaDbStore } = require('../../src/channel-manager/ota/store/dbStore');

  let pool, ctx;
  const withT = (fn) => H.withTenant(pool, ctx.tenantId, fn);
  const store = (c) => buildOtaDbStore({ db: c });

  async function seedTenantProperty() {
    const tid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const pid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const code = 'OTA-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    await H.withTenant(pool, tid, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tid, code, code]);
      await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid, tid, code, code, 'LKR']);
    });
    return { tenantId: tid, propertyId: pid };
  }

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regclass('public.ota_sync_attempt') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: ota_sync_attempt missing - migrate the target DB before running');
    ctx = await seedTenantProperty();
  });
  after(async () => {
    if (pool) {
      await H.withTenant(pool, ctx.tenantId, async (c) => {
        for (const t of ['ota_sync_attempt', 'ota_drift', 'ota_transport_health']) await c.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [ctx.tenantId]);
        await c.query('DELETE FROM properties WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM tenants WHERE id=$1', [ctx.tenantId]);
      });
      await pool.end();
    }
  });

  test('idempotent sync-attempt recording: same idempotency key is deduped', async () => {
    const rec = (k) => withT((c) => store(c).recordAttempt({ tenant_id: ctx.tenantId, propertyId: ctx.propertyId, channel: 'BOOKING_COM', op: 'pushRateUpdate', status: 'OK', attempts: 1, idempotencyKey: k }));
    const a = await rec('idem-1');
    const b = await rec('idem-1');
    assert.equal(a.accepted, true);
    assert.equal(b.deduped, true);
    const n = await withT((c) => c.query("SELECT count(*)::int n FROM ota_sync_attempt WHERE tenant_id=$1 AND idempotency_key='idem-1'", [ctx.tenantId]).then((r) => r.rows[0].n));
    assert.equal(n, 1);
  });

  test('status CHECK constraint rejects an unknown status', async () => {
    await assert.rejects(
      () => withT((c) => c.query("INSERT INTO ota_sync_attempt (tenant_id, channel, op, status) VALUES ($1,'BOOKING_COM','x','MAYBE')", [ctx.tenantId])),
      (e) => H.isPgError(e, '23514'));
  });

  test('metrics aggregate OK/FAILED/retries for a channel', async () => {
    await withT(async (c) => {
      const s = store(c);
      await s.recordAttempt({ tenant_id: ctx.tenantId, channel: 'EXPEDIA', op: 'pushAvailability', status: 'OK', attempts: 1, idempotencyKey: 'm1' });
      await s.recordAttempt({ tenant_id: ctx.tenantId, channel: 'EXPEDIA', op: 'pushAvailability', status: 'FAILED', attempts: 3, idempotencyKey: 'm2' });
      const m = await s.metrics(ctx.tenantId, 'EXPEDIA');
      assert.equal(m.total, 2); assert.equal(m.ok, 1); assert.equal(m.failed, 1); assert.equal(m.retries, 2);
    });
  });

  test('drift records persist and read back', async () => {
    await withT(async (c) => {
      const s = store(c);
      await s.recordDrift([{ tenant_id: ctx.tenantId, property_id: ctx.propertyId, channel: 'BOOKING_COM', drift_kind: 'inventory', mismatch_type: 'value_mismatch', resource_key: 'rt|2026-07-01', local_value: { available: 5 }, remote_value: { available: 4 }, recommendation: 'resync_inventory' }]);
      const rows = await s.listDrift({ tenant_id: ctx.tenantId, channel: 'BOOKING_COM' });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].mismatch_type, 'value_mismatch');
      assert.equal(rows[0].recommendation, 'resync_inventory');
    });
  });

  test('transport health upsert sets last_ok_at on healthy and escalates on failures', async () => {
    await withT(async (c) => {
      const s = store(c);
      const ok = await s.upsertHealth({ tenant_id: ctx.tenantId, channel: 'BOOKING_COM', status: 'healthy', consecutiveFailures: 0 });
      assert.ok(ok.last_ok_at, 'last_ok_at set when healthy');
      const down = await s.upsertHealth({ tenant_id: ctx.tenantId, channel: 'BOOKING_COM', status: 'down', consecutiveFailures: 3, lastError: 'http_503' });
      assert.equal(down.status, 'down');
      assert.ok(down.last_ok_at, 'last_ok_at retained from the prior healthy upsert');
      assert.equal((await s.getHealth(ctx.tenantId, 'BOOKING_COM')).consecutive_failures, 3);
    });
  });

  test('RLS: another tenant cannot see this tenant OTA sync attempts', async () => {
    const otherTid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    await H.withTenant(pool, otherTid, (c) => c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [otherTid, 'OTH-' + otherTid.slice(0, 6), 'oth']));
    const n = await H.withTenant(pool, otherTid, (c) => c.query('SELECT count(*)::int n FROM ota_sync_attempt').then((r) => r.rows[0].n));
    assert.equal(n, 0);
    await H.withTenant(pool, otherTid, (c) => c.query('DELETE FROM tenants WHERE id=$1', [otherTid]));
  });
}
