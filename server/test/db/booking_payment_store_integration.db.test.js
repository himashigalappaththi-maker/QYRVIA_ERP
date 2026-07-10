'use strict';

/**
 * Phase 55 — DB-backed payment store integration tests.
 *
 * Tests booking_payment_state and payment_attempt_log against a real PostgreSQL
 * instance with FORCE RLS enforced. Verifies:
 *   - Upsert / conflict resolution
 *   - Tenant isolation (tenant A cannot see tenant B's rows under RLS)
 *   - Append-only enforcement (UPDATE/DELETE revoked from PUBLIC on payment_attempt_log)
 *   - findExpiredHolds filter correctness
 *   - FORCE RLS returns zero rows when app.tenant_id is not set
 *
 * Activation: set TEST_DATABASE_URL to a non-superuser, non-BYPASSRLS role.
 * Without it, this file registers a single skipped placeholder test.
 */

const { test, before, after } = require('node:test');
const assert   = require('node:assert/strict');
const crypto   = require('node:crypto');

const H = require('./_dbHarness');
const G = require('./_rlsGuard');

const { buildPaymentStateStoreDb }  = require('../../src/payment/paymentStateStoreDb');
const { buildPaymentAttemptLogDb }  = require('../../src/payment/paymentAttemptLogDb');

const URL = H.dbConfig();

// ── Skip guard ────────────────────────────────────────────────────────────────
if (!URL) {
  test('booking_payment_store_integration: DB mode disabled (set TEST_DATABASE_URL to enable)', { skip: true }, () => {});
} else {

  let adminPool;
  let appPool;

  before(async () => {
    adminPool = H.newPool(URL);
    await H.freshSchema(adminPool);
    const { role, password } = await H.setupAppRole(adminPool);
    appPool = H.newPool(H.roleUrl(URL, role, password));
    await G.assertRlsCapableRole(appPool);
  });

  after(async () => {
    await appPool.end();
    await adminPool.end();
  });

  // Unique 4-char suffix to prevent collisions on tenants.code UNIQUE constraint
  // when seedTenant() is called multiple times in the same freshSchema session.
  function uid() { return crypto.randomBytes(3).toString('hex'); }

  // Seed one tenant + property with guaranteed-unique code per call.
  async function seedTenant(label) {
    const s = uid();
    return H.seedTenantProperty(adminPool, { code: label + s, propCode: 'P' + s });
  }

  // Seed two independent tenants + properties per test (unique codes every time).
  async function seedTwo() {
    const a = await seedTenant('TA');
    const b = await seedTenant('TB');
    return { a, b };
  }

  // Seed minimal FK chain: guest → room_type → reservation.
  // Returns { guestId, roomTypeId, reservationId }.
  async function seedReservation(tenantId, propertyId) {
    const guestId       = crypto.randomUUID();
    const roomTypeId    = crypto.randomUUID();
    const reservationId = crypto.randomUUID();

    await H.withTenant(adminPool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO guests
           (id, tenant_id, property_id, first_name, email)
         VALUES ($1, $2, $3, 'DB Test', 'dbtest@qyrvia.test')`,
        [guestId, tenantId, propertyId]
      );
      await c.query(
        `INSERT INTO room_types
           (id, tenant_id, property_id, code, name)
         VALUES ($1, $2, $3, 'STD', 'Standard')`,
        [roomTypeId, tenantId, propertyId]
      );
      // primary_adult_guest_id is NOT NULL — reuse guestId
      await c.query(`
        INSERT INTO reservations (
          id, tenant_id, property_id, reservation_number, reservation_type, status,
          holder_guest_id, primary_adult_guest_id,
          arrival_date, departure_date, adults, children, room_type_id, rooms_count
        ) VALUES (
          $1, $2, $3, $4,
          'INDIVIDUAL'::reservation_type, 'INQUIRY'::reservation_status,
          $5, $5,
          '2026-10-01', '2026-10-03', 2, 0, $6, 1
        )
      `, [reservationId, tenantId, propertyId, 'DB-' + reservationId.slice(0, 8), guestId, roomTypeId]);
    });

    return { guestId, roomTypeId, reservationId };
  }

  // ── 1. paymentStateStoreDb.upsert inserts, readable via getByReservationId ──

  test('paymentStateStoreDb: upsert inserts a row readable by getByReservationId', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const storeA = buildPaymentStateStoreDb({ db: H.tenantBoundPool(URL, a.tenantId) });
    const ctx = { tenantId: a.tenantId, propertyId: a.propertyId };

    await storeA.upsert({
      tenant_id: a.tenantId, property_id: a.propertyId,
      reservation_id: reservationId,
      payment_status: 'pending_payment',
      deposit_amount: 300, deposit_currency: 'USD', provider: 'mock',
      hold_expires_at: new Date(Date.now() + 900000).toISOString(),
    }, ctx);

    const row = await storeA.getByReservationId(reservationId, ctx);
    assert.ok(row, 'row should be readable');
    assert.equal(row.reservation_id, reservationId);
    assert.equal(row.payment_status, 'pending_payment');
    assert.equal(row.tenant_id, a.tenantId);
  });

  // ── 2. Second upsert updates existing row (no duplicate) ─────────────────

  test('paymentStateStoreDb: second upsert updates existing row (no duplicate)', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const storeA = buildPaymentStateStoreDb({ db: H.tenantBoundPool(URL, a.tenantId) });
    const ctx = { tenantId: a.tenantId, propertyId: a.propertyId };

    await storeA.upsert({
      tenant_id: a.tenantId, property_id: a.propertyId,
      reservation_id: reservationId,
      payment_status: 'pending_payment',
      deposit_amount: 300, deposit_currency: 'USD', provider: 'mock',
    }, ctx);

    await storeA.upsert({
      reservation_id: reservationId,
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    }, ctx);

    const row = await storeA.getByReservationId(reservationId, ctx);
    assert.equal(row.payment_status, 'paid', 'status should be updated to paid');
  });

  // ── 3. getByReservationId: non-existent → null ──────────────────────────

  test('paymentStateStoreDb.getByReservationId: missing reservation → null', async () => {
    const { a } = await seedTwo();
    const storeA = buildPaymentStateStoreDb({ db: H.tenantBoundPool(URL, a.tenantId) });
    const ctx = { tenantId: a.tenantId };
    const row = await storeA.getByReservationId(crypto.randomUUID(), ctx);
    assert.equal(row, null);
  });

  // ── 4. Tenant isolation on booking_payment_state ─────────────────────────

  test('paymentStateStoreDb: tenant A row invisible to tenant B (explicit tenant_id filter)', async () => {
    const { a, b } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const storeA = buildPaymentStateStoreDb({ db: H.tenantBoundPool(URL, a.tenantId) });
    const storeB = buildPaymentStateStoreDb({ db: H.tenantBoundPool(URL, b.tenantId) });

    await storeA.upsert({
      tenant_id: a.tenantId, property_id: a.propertyId,
      reservation_id: reservationId,
      payment_status: 'pending_payment',
      deposit_amount: 150, deposit_currency: 'USD', provider: 'mock',
    }, { tenantId: a.tenantId });

    // B queries with its own tenantId — explicit AND tenant_id=$2 must return null
    const row = await storeB.getByReservationId(reservationId, { tenantId: b.tenantId });
    assert.equal(row, null, 'tenant B must not see tenant A payment state row');
  });

  // ── 5. paymentAttemptLogDb: two inserts → both readable ──────────────────

  test('paymentAttemptLogDb: two inserts → two rows in listByReservation', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPool = H.tenantBoundPool(URL, a.tenantId);
    const logA = buildPaymentAttemptLogDb({ db: tPool });
    const ctx = { tenantId: a.tenantId, propertyId: a.propertyId };

    await logA.insert({
      tenant_id: a.tenantId, property_id: a.propertyId,
      reservation_id: reservationId, provider: 'mock',
      amount: 200, currency: 'USD', status: 'initiated',
    }, ctx);
    await logA.insert({
      tenant_id: a.tenantId, property_id: a.propertyId,
      reservation_id: reservationId, provider: 'mock',
      amount: 200, currency: 'USD', status: 'success',
    }, ctx);

    const rows = await logA.listByReservation(reservationId, ctx);
    assert.equal(rows.length, 2, 'should have two attempt log entries');
    assert.ok(rows.some((r) => r.status === 'success'), 'success row should be present');
    await tPool.end();
  });

  // ── 6. Append-only: PUBLIC cannot UPDATE/DELETE on payment_attempt_log ───

  test('payment_attempt_log: PUBLIC cannot UPDATE or DELETE (append-only enforcement)', async () => {
    await G.assertAppendOnlyRevoked(appPool);
  });

  // ── 7. Tenant isolation on payment_attempt_log ───────────────────────────

  test('paymentAttemptLogDb: tenant A rows invisible to tenant B under RLS', async () => {
    const { a, b } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPoolA = H.tenantBoundPool(URL, a.tenantId);
    const tPoolB = H.tenantBoundPool(URL, b.tenantId);
    const logA = buildPaymentAttemptLogDb({ db: tPoolA });
    const logB = buildPaymentAttemptLogDb({ db: tPoolB });

    await logA.insert({
      tenant_id: a.tenantId, property_id: a.propertyId,
      reservation_id: reservationId, provider: 'mock',
      amount: 100, currency: 'USD', status: 'initiated',
    }, { tenantId: a.tenantId });

    const rows = await logB.listByReservation(reservationId, { tenantId: b.tenantId });
    assert.equal(rows.length, 0, 'tenant B must not see tenant A attempt log rows');
    await tPoolA.end();
    await tPoolB.end();
  });

  // ── 8. findExpiredHolds returns only expired pending rows ─────────────────

  test('paymentStateStoreDb.findExpiredHolds: returns expired pending_payment, skips active/paid', async () => {
    const { a } = await seedTwo();
    const { reservationId: expiredId } = await seedReservation(a.tenantId, a.propertyId);
    const { reservationId: activeId  } = await seedReservation(a.tenantId, a.propertyId);
    const { reservationId: paidId    } = await seedReservation(a.tenantId, a.propertyId);

    const tPool = H.tenantBoundPool(URL, a.tenantId);
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

    // findExpiredHolds needs a tenant-scoped client for FORCE RLS
    const expired = await H.withTenant(tPool, a.tenantId, (client) =>
      store.findExpiredHolds(client)
    );

    // Must contain the expired row
    assert.ok(expired.some((r) => r.reservation_id === expiredId),
      'expired pending_payment row must be in results');
    // Active and paid rows must NOT appear
    assert.ok(!expired.some((r) => r.reservation_id === activeId),
      'non-expired pending_payment must not appear');
    assert.ok(!expired.some((r) => r.reservation_id === paidId),
      'paid row must not appear even with past hold_expires_at');

    await tPool.end();
  });

  // ── 9. FORCE RLS returns zero rows when GUC not set ─────────────────────

  test('paymentStateStoreDb.findExpiredHolds: FORCE RLS → zero rows when app.tenant_id not set', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(a.tenantId, a.propertyId);

    const tPool = H.tenantBoundPool(URL, a.tenantId);
    const storeT = buildPaymentStateStoreDb({ db: tPool });
    await storeT.upsert({
      tenant_id: a.tenantId, property_id: a.propertyId, reservation_id: reservationId,
      payment_status: 'pending_payment', deposit_amount: 50, deposit_currency: 'USD',
      provider: 'mock', hold_expires_at: new Date(Date.now() - 1000).toISOString(),
    }, { tenantId: a.tenantId });

    // Query via appPool (non-superuser, NON-BYPASSRLS) with no GUC set.
    // FORCE RLS + app_current_tenant() returning NULL → zero rows.
    const storeRaw = buildPaymentStateStoreDb({ db: appPool });
    const rows = await storeRaw.findExpiredHolds();
    assert.equal(rows.length, 0, 'FORCE RLS must return zero rows when app.tenant_id is not set');

    await tPool.end();
  });

  // ── 10. All tenant tables pass RLS guard ────────────────────────────────

  test('assertAllTenantTablesSecured: booking_payment_state and payment_attempt_log have FORCE RLS', async () => {
    const count = await G.assertAllTenantTablesSecured(appPool);
    assert.ok(count > 0, 'at least one tenant-scoped table must exist');
  });

}
