'use strict';

/**
 * Phase 29 - Channel inbound: stale events + monotonic status enforcement against
 * REAL PostgreSQL (DB mode).  STRICT data-level boundary:
 *   - NO DDL, NO CREATE ROLE, NO DROP SCHEMA, NO migration at runtime.
 *   - Assumes the schema is already provisioned + migrated in the target DB.
 *   - Connects with the single existing role (TEST_DATABASE_URL = qyrvia_test).
 *   - Operates only at the data layer; cleans up its own fixtures with DELETE.
 *
 * Because channel_booking_store uses FORCE ROW LEVEL SECURITY, RLS binds even to
 * the (non-superuser) table owner, so every statement runs inside a tenant context
 * (app.tenant_id) - which is also how production withTenant() runs.
 *
 * Validates: higher status rank advances + persists; equal/lower rank is a stale
 * no-op; CANCELLED after physical presence is rejected. All assertions are scoped
 * to THIS run's tenant id (the DB is not reset between runs).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'db-mode-jwt-secret-at-least-32-characters-long';
  process.env.DATABASE_URL = process.env.DATABASE_URL || URL;

  const { buildBookingStoreDb } = require('../../src/channel-manager/persistence/dbStores');
  const { buildChannelInboundService } = require('../../src/channel-manager/inbound/channelInboundService');

  let pool, ctx;
  const commandBus = { dispatch: async () => ({ ok: true, result: {} }) }; // no PMS id => no FK to reservations

  // tenant-scoped fixture seeding (FORCE RLS: the row's tenant must equal app.tenant_id)
  async function seedTenantProperty() {
    const tid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const pid = (await pool.query('SELECT gen_random_uuid() id')).rows[0].id;
    const code = 'INB-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    await H.withTenant(pool, tid, async (c) => {
      await c.query('INSERT INTO tenants (id, code, name) VALUES ($1,$2,$3)', [tid, code, code]);
      await c.query('INSERT INTO properties (id, tenant_id, code, name, currency) VALUES ($1,$2,$3,$4,$5)', [pid, tid, code, code, 'LKR']);
    });
    return { tenantId: tid, propertyId: pid };
  }

  // run ingest inside the tenant context, with the booking_store bound to that tx client
  async function ingest(booking) {
    return H.withTenant(pool, ctx.tenantId, async (c) => {
      const svc = buildChannelInboundService({ bookingStore: buildBookingStoreDb({ db: c }), commandBus });
      return svc.ingest(booking, { ctx });
    });
  }
  async function row(ref) {
    return H.withTenant(pool, ctx.tenantId, async (c) =>
      (await c.query('SELECT status, version FROM channel_booking_store WHERE tenant_id=$1 AND channel=$2 AND external_ref=$3',
        [ctx.tenantId, 'BOOKING_COM', ref])).rows[0]);
  }

  before(async () => {
    pool = H.newPool(URL);
    const reg = await pool.query("SELECT to_regclass('public.channel_booking_store') t");
    assert.ok(reg.rows[0].t, 'schema not provisioned: channel_booking_store missing - migrate the target DB before running (setup step, outside tests)');
    ctx = await seedTenantProperty();
  });
  after(async () => {
    if (pool) {
      await H.withTenant(pool, ctx.tenantId, async (c) => {
        await c.query('DELETE FROM channel_booking_store WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM properties WHERE tenant_id=$1', [ctx.tenantId]);
        await c.query('DELETE FROM tenants WHERE id=$1', [ctx.tenantId]);
      });
      await pool.end();
    }
  });

  const C = (o) => Object.assign({ channel: 'BOOKING_COM', guestName: 'G', arrival: '2026-07-01', departure: '2026-07-03' }, o);

  test('higher-rank events advance and persist to the real booking_store', async () => {
    const ref = 'BC-ADV';
    await ingest(C({ bookingId: ref, status: 'PENDING' }));
    await ingest(C({ bookingId: ref, status: 'CONFIRMED' }));
    const r = await ingest(C({ bookingId: ref, status: 'CHECKED_IN' }));
    assert.equal(r.ok, true);
    const got = await row(ref);
    assert.equal(got.status, 'CHECKED_IN');
    assert.equal(got.version, 3, 'each real advance bumps the persisted version');
  });

  test('equal/lower-rank event is a stale no-op (persisted row unchanged)', async () => {
    const ref = 'BC-STALE';
    await ingest(C({ bookingId: ref, status: 'CHECKED_IN' }));
    const before = await row(ref);
    const lower = await ingest(C({ bookingId: ref, status: 'CONFIRMED' })); // rank 2 <= 3
    const equal = await ingest(C({ bookingId: ref, status: 'CHECKED_IN' })); // rank 3 <= 3
    assert.equal(lower.deduped, true);
    assert.equal(equal.deduped, true);
    const after = await row(ref);
    assert.equal(after.status, 'CHECKED_IN');
    assert.equal(after.version, before.version, 'no write occurred for stale/duplicate events');
  });

  test('CANCELLED after physical presence is rejected and never mutates the row', async () => {
    const ref = 'BC-CANCEL-PRESENT';
    await ingest(C({ bookingId: ref, status: 'CHECKED_IN' }));
    const r = await ingest(C({ bookingId: ref, status: 'CANCELLED' }));
    assert.equal(r.ok, false);
    assert.equal(r.exception, true);
    assert.equal(r.error, 'cannot_cancel_present');
    assert.equal((await row(ref)).status, 'CHECKED_IN');
  });

  test('CANCELLED before presence is a valid forward transition', async () => {
    const ref = 'BC-CANCEL-OK';
    await ingest(C({ bookingId: ref, status: 'PENDING' }));
    const r = await ingest(C({ bookingId: ref, status: 'CANCELLED' }));
    assert.equal(r.ok, true);
    assert.equal((await row(ref)).status, 'CANCELLED');
  });

  test('idempotent re-delivery of the same event does not duplicate rows', async () => {
    const ref = 'BC-IDEM';
    await ingest(C({ bookingId: ref, status: 'CONFIRMED' }));
    await ingest(C({ bookingId: ref, status: 'CONFIRMED' }));
    const n = await H.withTenant(pool, ctx.tenantId, async (c) =>
      (await c.query('SELECT count(*)::int n FROM channel_booking_store WHERE tenant_id=$1 AND external_ref=$2', [ctx.tenantId, ref])).rows[0].n);
    assert.equal(n, 1, 'natural key (tenant,channel,external_ref) yields exactly one row');
  });
}
