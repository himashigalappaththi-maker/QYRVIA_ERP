'use strict';

/**
 * Phase 55 — DB-backed payment store integration tests.
 *
 * Single-role model: connects as the existing non-superuser qyrvia_test role
 * (TEST_DATABASE_URL). NO freshSchema, NO CREATE ROLE, NO superuser. The schema
 * is already provisioned and migrated by the CI workflow before this suite runs.
 * Each test seeds its own data with unique codes and the after() hook deletes it.
 *
 * Verifies:
 *   - paymentStateStoreDb upsert / conflict-update / null-miss
 *   - Tenant isolation via explicit tenant_id filter in getByReservationId
 *   - paymentAttemptLogDb insert + listByReservation
 *   - Append-only enforcement (UPDATE/DELETE revoked from PUBLIC)
 *   - findExpiredHolds filter (expired pending_payment only)
 *   - FORCE RLS zero-rows when app.tenant_id GUC is not set
 *   - All tenant tables have ENABLE+FORCE RLS (assertAllTenantTablesSecured)
 */

const { test, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const crypto  = require('node:crypto');

const H = require('./_dbHarness');
const G = require('./_rlsGuard');

const { buildPaymentStateStoreDb } = require('../../src/payment/paymentStateStoreDb');
const { buildPaymentAttemptLogDb }  = require('../../src/payment/paymentAttemptLogDb');

const URL = H.dbConfig();

// ── Skip guard ────────────────────────────────────────────────────────────────
if (!URL) {
  test('booking_payment_store_integration: DB mode disabled (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {

  let pool;
  // Track every tenantId created so after() can clean up.
  const allTenants = [];

  before(async () => {
    pool = H.newPool(URL);
    // Verify the schema is migrated — abort early with a clear message if not.
    const check = await pool.query("SELECT to_regclass('public.booking_payment_state') t");
    assert.ok(check.rows[0].t,
      'booking_payment_state missing — run migrations before this suite');
  });

  after(async () => {
    if (!pool) return;
    for (const tenantId of allTenants) {
      // Delete in FK-dependency order within the tenant's RLS context.
      await H.withTenant(pool, tenantId, async (c) => {
        await c.query('DELETE FROM booking_payment_state WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM payment_attempt_log  WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM reservations          WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM guests                WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM room_types            WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM properties            WHERE tenant_id=$1', [tenantId]);
        await c.query('DELETE FROM tenants               WHERE id        =$1', [tenantId]);
      }).catch(() => {/* best-effort */});
    }
    await pool.end();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Short unique suffix to avoid UNIQUE-constraint collisions on tenant codes.
  function uid() { return crypto.randomBytes(3).toString('hex'); }

  async function seedTenant(label) {
    const t = await H.seedTenantProperty(pool, {
      code:     label + '-' + uid(),
      propCode: 'P-' + uid(),
    });
    allTenants.push(t.tenantId);
    return t;
  }

  async function seedTwo() {
    return { a: await seedTenant('BPS-A'), b: await seedTenant('BPS-B') };
  }

  // Seed guest → room_type → reservation.
  // Returns { guestId, roomTypeId, reservationId }.
  async function seedReservation(tenantId, propertyId) {
    const guestId       = crypto.randomUUID();
    const roomTypeId    = crypto.randomUUID();
    const reservationId = crypto.randomUUID();

    await H.withTenant(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO guests (id, tenant_id, property_id, first_name, email)
         VALUES ($1,$2,$3,'Test','bps-test@qyrvia.test')`,
        [guestId, tenantId, propertyId]);

      await c.query(
        `INSERT INTO room_types (id, tenant_id, property_id, code, name)
         VALUES ($1,$2,$3,'STD-' || $4,'Standard')`,
        [roomTypeId, tenantId, propertyId, uid()]);

      // primary_adult_guest_id NOT NULL — reuse guestId
      await c.query(`
        INSERT INTO reservations
          (id, tenant_id, property_id, reservation_number, reservation_type, status,
           holder_guest_id, primary_adult_guest_id,
           arrival_date, departure_date, adults, children, room_type_id, rooms_count)
        VALUES ($1,$2,$3,$4,'INDIVIDUAL'::reservation_type,'INQUIRY'::reservation_status,
                $5,$5,'2026-10-01','2026-10-03',2,0,$6,1)`,
        [reservationId, tenantId, propertyId,
         'BPS-' + reservationId.slice(0, 8), guestId, roomTypeId]);
    });

    return { guestId, roomTypeId, reservationId };
  }

  // ── 1. upsert inserts a row readable via getByReservationId ───────────────

  test('paymentStateStoreDb: upsert inserts, readable by getByReservationId', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    // tenantBoundPool pins app.tenant_id so the store's upsert/query satisfies FORCE RLS
    const tPool = H.tenantBoundPool(URL, a.tenantId);
    try {
      const store = buildPaymentStateStoreDb({ db: tPool });
      const ctx = { tenantId: a.tenantId, propertyId: a.propertyId };

      await store.upsert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: reservationId, payment_status: 'pending_payment',
        deposit_amount: 300, deposit_currency: 'USD', provider: 'mock',
        hold_expires_at: new Date(Date.now() + 900000).toISOString() }, ctx);

      const row = await store.getByReservationId(reservationId, ctx);
      assert.ok(row, 'row must be readable after upsert');
      assert.equal(row.reservation_id, reservationId);
      assert.equal(row.payment_status, 'pending_payment');
      assert.equal(row.tenant_id, a.tenantId);
    } finally { await tPool.end(); }
  });

  // ── 2. Second upsert updates existing row ─────────────────────────────────

  test('paymentStateStoreDb: second upsert updates existing row (no duplicate)', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPool = H.tenantBoundPool(URL, a.tenantId);
    try {
      const store = buildPaymentStateStoreDb({ db: tPool });
      const ctx = { tenantId: a.tenantId, propertyId: a.propertyId };

      await store.upsert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: reservationId, payment_status: 'pending_payment',
        deposit_amount: 300, deposit_currency: 'USD', provider: 'mock' }, ctx);

      await store.upsert({ reservation_id: reservationId, payment_status: 'paid',
        paid_at: new Date().toISOString() }, ctx);

      const row = await store.getByReservationId(reservationId, ctx);
      assert.equal(row.payment_status, 'paid', 'status should be updated to paid');
    } finally { await tPool.end(); }
  });

  // ── 3. getByReservationId: missing reservation → null ────────────────────

  test('paymentStateStoreDb.getByReservationId: non-existent → null', async () => {
    const { a } = await seedTwo();
    const store = buildPaymentStateStoreDb({ db: pool });
    const row = await store.getByReservationId(crypto.randomUUID(), { tenantId: a.tenantId });
    assert.equal(row, null);
  });

  // ── 4. Tenant isolation: explicit tenant_id filter in getByReservationId ──

  test('paymentStateStoreDb: tenant A row invisible to tenant B (explicit AND tenant_id filter)', async () => {
    const { a, b } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPoolA = H.tenantBoundPool(URL, a.tenantId);
    try {
      const storeA = buildPaymentStateStoreDb({ db: tPoolA });
      await storeA.upsert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: reservationId, payment_status: 'pending_payment',
        deposit_amount: 150, deposit_currency: 'USD', provider: 'mock' },
        { tenantId: a.tenantId });

      // Tenant B's ctx: explicit AND tenant_id=$2 filter means tenant A's row is invisible
      const storeAny = buildPaymentStateStoreDb({ db: pool });
      const row = await storeAny.getByReservationId(reservationId, { tenantId: b.tenantId });
      assert.equal(row, null, 'tenant B must not see tenant A payment state row');
    } finally { await tPoolA.end(); }
  });

  // ── 5. paymentAttemptLogDb: two inserts → both readable ──────────────────

  test('paymentAttemptLogDb: two inserts → two rows in listByReservation', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPool = H.tenantBoundPool(URL, a.tenantId);
    try {
      const logA = buildPaymentAttemptLogDb({ db: tPool });
      const ctx = { tenantId: a.tenantId, propertyId: a.propertyId };

      await logA.insert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: reservationId, provider: 'mock',
        amount: 200, currency: 'USD', status: 'initiated' }, ctx);
      await logA.insert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: reservationId, provider: 'mock',
        amount: 200, currency: 'USD', status: 'success' }, ctx);

      const rows = await logA.listByReservation(reservationId, ctx);
      assert.equal(rows.length, 2, 'should have two attempt log entries');
      assert.ok(rows.some((r) => r.status === 'success'), 'success entry should be present');
    } finally { await tPool.end(); }
  });

  // ── 6. Append-only: PUBLIC cannot UPDATE/DELETE on payment_attempt_log ───

  test('payment_attempt_log: PUBLIC cannot UPDATE or DELETE (append-only enforcement)', async () => {
    await G.assertAppendOnlyRevoked(pool);
  });

  // ── 7. Tenant isolation on payment_attempt_log ───────────────────────────

  test('paymentAttemptLogDb: tenant A rows invisible to tenant B under RLS', async () => {
    const { a, b } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPoolA = H.tenantBoundPool(URL, a.tenantId);
    const tPoolB = H.tenantBoundPool(URL, b.tenantId);
    try {
      const logA = buildPaymentAttemptLogDb({ db: tPoolA });
      await logA.insert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: reservationId, provider: 'mock',
        amount: 100, currency: 'USD', status: 'initiated' }, { tenantId: a.tenantId });

      const logB = buildPaymentAttemptLogDb({ db: tPoolB });
      const rows = await logB.listByReservation(reservationId, { tenantId: b.tenantId });
      assert.equal(rows.length, 0, 'tenant B must not see tenant A attempt log rows');
    } finally {
      await tPoolA.end();
      await tPoolB.end();
    }
  });

  // ── 8. findExpiredHolds returns only expired pending rows ─────────────────

  test('paymentStateStoreDb.findExpiredHolds: returns expired pending_payment, skips active/paid', async () => {
    const { a } = await seedTwo();
    const { reservationId: expiredId } = await seedReservation(a.tenantId, a.propertyId);
    const { reservationId: activeId  } = await seedReservation(a.tenantId, a.propertyId);
    const { reservationId: paidId    } = await seedReservation(a.tenantId, a.propertyId);

    const tPool = H.tenantBoundPool(URL, a.tenantId);
    try {
      const store = buildPaymentStateStoreDb({ db: tPool });
      const ctx = { tenantId: a.tenantId, propertyId: a.propertyId };

      await store.upsert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: expiredId, payment_status: 'pending_payment',
        deposit_amount: 100, deposit_currency: 'USD', provider: 'mock',
        hold_expires_at: new Date(Date.now() - 5000).toISOString() }, ctx);
      await store.upsert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: activeId, payment_status: 'pending_payment',
        deposit_amount: 100, deposit_currency: 'USD', provider: 'mock',
        hold_expires_at: new Date(Date.now() + 900000).toISOString() }, ctx);
      await store.upsert({ tenant_id: a.tenantId, property_id: a.propertyId,
        reservation_id: paidId, payment_status: 'paid',
        deposit_amount: 100, deposit_currency: 'USD', provider: 'mock',
        hold_expires_at: new Date(Date.now() - 1000).toISOString() }, ctx);

      // Pass a tenant-scoped client for FORCE RLS to return the correct rows
      const expired = await H.withTenant(tPool, a.tenantId, (client) =>
        store.findExpiredHolds(client)
      );

      assert.ok(expired.some((r) => r.reservation_id === expiredId),
        'expired pending_payment row must appear');
      assert.ok(!expired.some((r) => r.reservation_id === activeId),
        'non-expired pending_payment must not appear');
      assert.ok(!expired.some((r) => r.reservation_id === paidId),
        'paid row must not appear even with past hold_expires_at');
    } finally { await tPool.end(); }
  });

  // ── 9. FORCE RLS: zero rows when app.tenant_id GUC is not set ────────────

  test('paymentStateStoreDb.findExpiredHolds: zero rows when no GUC set (FORCE RLS proof)', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPool = H.tenantBoundPool(URL, a.tenantId);
    try {
      const storeT = buildPaymentStateStoreDb({ db: tPool });
      await storeT.upsert({
        tenant_id: a.tenantId, property_id: a.propertyId, reservation_id: reservationId,
        payment_status: 'pending_payment', deposit_amount: 50, deposit_currency: 'USD',
        provider: 'mock', hold_expires_at: new Date(Date.now() - 1000).toISOString(),
      }, { tenantId: a.tenantId });
    } finally { await tPool.end(); }

    // Plain pool — no withTenant wrapper, so no app.tenant_id GUC.
    // FORCE RLS + app_current_tenant() returning NULL → zero rows.
    const storeRaw = buildPaymentStateStoreDb({ db: pool });
    const rows = await storeRaw.findExpiredHolds();
    assert.equal(rows.length, 0,
      'FORCE RLS must return zero rows when app.tenant_id GUC is not set');
  });

  // ── 10. All tenant tables have ENABLE+FORCE RLS ──────────────────────────

  test('assertAllTenantTablesSecured: booking_payment_state and payment_attempt_log have FORCE RLS', async () => {
    const count = await G.assertAllTenantTablesSecured(pool);
    assert.ok(count > 0, 'at least one tenant-scoped table must exist');
  });

}
