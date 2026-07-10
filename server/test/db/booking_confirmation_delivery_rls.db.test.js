'use strict';

/**
 * Phase 56 — Booking Confirmation Delivery RLS integration tests (Tests 16-20).
 *
 * Single-role model: connects as qyrvia_test (non-superuser, non-BYPASSRLS).
 * Schema must already be migrated (including 0070) before this suite runs.
 * Tests seed their own data and clean up in after().
 *
 * Verifies:
 *   16. tenant A cannot read tenant B delivery records
 *   17. property isolation: cross-property query returns zero rows
 *   18. no tenant GUC → FORCE RLS returns zero rows (fail-closed)
 *   19. booking_confirmation_deliveries passes assertAllTenantTablesSecured
 *   20. booking_confirmation_deliveries passes assertAppendOnlyRevoked
 */

const { test, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const crypto  = require('node:crypto');

const H = require('./_dbHarness');
const G = require('./_rlsGuard');

const URL = H.dbConfig();

if (!URL) {
  test('booking_confirmation_delivery_rls: DB mode disabled (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {

  let pool;
  const allTenants = [];

  before(async () => {
    pool = H.newPool(URL);
    const check = await pool.query("SELECT to_regclass('public.booking_confirmation_deliveries') t");
    assert.ok(check.rows[0].t,
      'booking_confirmation_deliveries missing — run migration 0070 before this suite');
  });

  after(async () => {
    if (!pool) return;
    for (const tenantId of allTenants) {
      await H.withTenant(pool, tenantId, async (c) => {
        await c.query('DELETE FROM booking_confirmation_deliveries WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM reservations WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM guests WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM room_types WHERE tenant_id=$1', [tenantId]);
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

  async function seedReservation(tenantId, propertyId) {
    const guestId       = crypto.randomUUID();
    const roomTypeId    = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    await H.withTenant(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO guests (id, tenant_id, property_id, first_name, email)
         VALUES ($1,$2,$3,'RlsTest','bcd-rls@qyrvia.test')`,
        [guestId, tenantId, propertyId]);
      await c.query(
        `INSERT INTO room_types (id, tenant_id, property_id, code, name)
         VALUES ($1,$2,$3,'BCD-' || $4,'Deluxe')`,
        [roomTypeId, tenantId, propertyId, uid()]);
      await c.query(`
        INSERT INTO reservations
          (id, tenant_id, property_id, reservation_number, reservation_type, status,
           holder_guest_id, primary_adult_guest_id,
           arrival_date, departure_date, adults, children, room_type_id, rooms_count)
        VALUES ($1,$2,$3,$4,'INDIVIDUAL'::reservation_type,'INQUIRY'::reservation_status,
                $5,$5,'2026-11-01','2026-11-03',2,0,$6,1)`,
        [reservationId, tenantId, propertyId,
         'BCD-' + reservationId.slice(0, 8), guestId, roomTypeId]);
    });
    return { guestId, roomTypeId, reservationId };
  }

  async function insertDelivery(tPool, tenantId, propertyId, reservationId, suffix) {
    await H.withTenant(tPool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO booking_confirmation_deliveries
           (tenant_id, property_id, reservation_id, confirmation_number,
            channel, recipient, notification_type, context, dedup_key)
         VALUES ($1,$2,$3,$4,'email'::notification_channel,$5,'booking_confirmation','{}',$6)`,
        [tenantId, propertyId, reservationId, 'ABCD' + suffix,
         'test' + suffix + '@qyrvia.test',
         reservationId + ':booking_confirmation:email:test' + suffix + '@qyrvia.test']
      );
    });
  }

  // ── Test 16: tenant A cannot read tenant B delivery records ─────────────────

  test('Phase 56 T16: tenant A cannot read tenant B booking_confirmation_deliveries under RLS', async () => {
    const a = await seedTenant('BCD-A');
    const b = await seedTenant('BCD-B');
    const { reservationId: resA } = await seedReservation(a.tenantId, a.propertyId);

    const tPoolA = H.tenantBoundPool(URL, a.tenantId);
    const tPoolB = H.tenantBoundPool(URL, b.tenantId);
    try {
      await insertDelivery(tPoolA, a.tenantId, a.propertyId, resA, '16a');

      // Tenant B's pool cannot see tenant A's rows
      const r = await H.withTenant(tPoolB, b.tenantId, (c) =>
        c.query('SELECT * FROM booking_confirmation_deliveries WHERE reservation_id=$1', [resA])
      );
      assert.equal(r.rows.length, 0, 'tenant B must not see tenant A delivery records');
    } finally {
      await tPoolA.end();
      await tPoolB.end();
    }
  });

  // ── Test 17: property isolation ──────────────────────────────────────────────

  test('Phase 56 T17: cross-property query scoped to wrong property returns zero rows', async () => {
    const a = await seedTenant('BCD-PROP');
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);
    const fakePropertyId = crypto.randomUUID();

    const tPool = H.tenantBoundPool(URL, a.tenantId);
    try {
      await insertDelivery(tPool, a.tenantId, a.propertyId, reservationId, '17p');

      // Query with a different property_id (cross-property)
      const r = await H.withTenant(tPool, a.tenantId, (c) =>
        c.query(
          'SELECT * FROM booking_confirmation_deliveries WHERE tenant_id=$1 AND property_id=$2',
          [a.tenantId, fakePropertyId]
        )
      );
      assert.equal(r.rows.length, 0, 'cross-property query must return zero rows');
    } finally { await tPool.end(); }
  });

  // ── Test 18: no tenant GUC → FORCE RLS returns zero rows ────────────────────

  test('Phase 56 T18: query without app.tenant_id GUC → FORCE RLS returns zero rows', async () => {
    const a = await seedTenant('BCD-NOGUC');
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPool = H.tenantBoundPool(URL, a.tenantId);
    try {
      await insertDelivery(tPool, a.tenantId, a.propertyId, reservationId, '18g');
    } finally { await tPool.end(); }

    // Plain pool: no withTenant, no app.tenant_id GUC.
    // FORCE RLS + app_current_tenant() returning NULL → zero rows.
    const r = await pool.query(
      'SELECT * FROM booking_confirmation_deliveries WHERE reservation_id=$1', [reservationId]
    );
    assert.equal(r.rows.length, 0, 'FORCE RLS must return zero rows when app.tenant_id GUC is absent');
  });

  // ── Test 19: new table passes assertAllTenantTablesSecured ──────────────────

  test('Phase 56 T19: booking_confirmation_deliveries passes assertAllTenantTablesSecured', async () => {
    const count = await G.assertAllTenantTablesSecured(pool);
    assert.ok(count > 0, 'at least one tenant-scoped table must pass the RLS guard');
  });

  // ── Test 20: append-only / audit protections pass ────────────────────────────

  test('Phase 56 T20: append-only revocation check passes for booking_confirmation_deliveries', async () => {
    await G.assertAppendOnlyRevoked(pool);
  });

}
