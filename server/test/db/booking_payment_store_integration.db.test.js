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
  let appPool;   // NON-superuser, NON-BYPASSRLS role

  before(async () => {
    adminPool = H.newPool(URL);
    await H.freshSchema(adminPool);
    const { role, password } = await H.setupAppRole(adminPool);
    appPool = H.newPool(H.roleUrl(URL, role, password));
    // Guard: reject if role is superuser / BYPASSRLS (RLS would be bypassed).
    await G.assertRlsCapableRole(appPool);
  });

  after(async () => {
    await appPool.end();
    await adminPool.end();
  });

  // Seed two independent tenants + properties
  async function seedTwo() {
    const a = await H.seedTenantProperty(adminPool, { code: 'TA', propCode: 'PA' });
    const b = await H.seedTenantProperty(adminPool, { code: 'TB', propCode: 'PB' });
    return { a, b };
  }

  // Seed minimal FK chain: room_type → reservation → booking_payment_state / payment_attempt_log
  async function seedReservation(pool, tenantId, propertyId) {
    const guestId      = crypto.randomUUID();
    const roomTypeId   = crypto.randomUUID();
    const reservationId = crypto.randomUUID();

    await H.withTenant(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO guests (id, tenant_id, property_id, full_name, email)
         VALUES ($1, $2, $3, 'DB Test Guest', 'dbtest@example.com')`,
        [guestId, tenantId, propertyId]
      );
      await c.query(
        `INSERT INTO room_types (id, tenant_id, property_id, code, name, physical)
         VALUES ($1, $2, $3, 'STD', 'Standard', 10)`,
        [roomTypeId, tenantId, propertyId]
      );
      await c.query(`
        INSERT INTO reservations (
          id, tenant_id, property_id, reservation_number, reservation_type, status,
          holder_guest_id, arrival_date, departure_date, adults, children, room_type_id, rooms_count
        ) VALUES ($1, $2, $3, $4, 'INDIVIDUAL'::reservation_type,
                  'INQUIRY'::reservation_status, $5, '2026-10-01', '2026-10-03', 2, 0, $6, 1)
      `, [reservationId, tenantId, propertyId, 'DB-' + reservationId.slice(0, 8), guestId, roomTypeId]);
    });

    return { guestId, roomTypeId, reservationId };
  }

  // ── 1. paymentStateStoreDb.upsert inserts, readable via getByReservationId ───

  test('paymentStateStoreDb: upsert inserts a row readable by getByReservationId', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(adminPool, a.tenantId, a.propertyId);

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

  // ── 2. upsert conflict: second write updates existing row ─────────────────

  test('paymentStateStoreDb: second upsert updates existing row (no duplicate)', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(adminPool, a.tenantId, a.propertyId);

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

  // ── 3. getByReservationId: non-existent → null ───────────────────────────

  test('paymentStateStoreDb.getByReservationId: missing reservation → null', async () => {
    const { a } = await seedTwo();
    const storeA = buildPaymentStateStoreDb({ db: H.tenantBoundPool(URL, a.tenantId) });
    const ctx = { tenantId: a.tenantId };
    const row = await storeA.getByReservationId(crypto.randomUUID(), ctx);
    assert.equal(row, null);
  });

  // ── 4. Tenant isolation on booking_payment_state ──────────────────────────

  test('paymentStateStoreDb: tenant A row is invisible to tenant B under RLS', async () => {
    const { a, b } = await seedTwo();
    const { reservationId } = await seedReservation(adminPool, a.tenantId, a.propertyId);

    const storeA = buildPaymentStateStoreDb({ db: H.tenantBoundPool(URL, a.tenantId) });
    const storeB = buildPaymentStateStoreDb({ db: H.tenantBoundPool(URL, b.tenantId) });

    await storeA.upsert({
      tenant_id: a.tenantId, property_id: a.propertyId,
      reservation_id: reservationId,
      payment_status: 'pending_payment',
      deposit_amount: 150, deposit_currency: 'USD', provider: 'mock',
    }, { tenantId: a.tenantId });

    // Tenant B cannot see tenant A's row
    const row = await storeB.getByReservationId(reservationId, { tenantId: b.tenantId });
    assert.equal(row, null, 'tenant B must not see tenant A payment state row');
  });

  // ── 5. paymentAttemptLogDb: insert two entries → both readable ────────────

  test('paymentAttemptLogDb: two inserts → two rows in listByReservation', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(adminPool, a.tenantId, a.propertyId);

    const logA = buildPaymentAttemptLogDb({ db: H.tenantBoundPool(URL, a.tenantId) });
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
    assert.equal(rows[0].status, 'success', 'most recent first');
  });

  // ── 6. Append-only: UPDATE/DELETE revoked on payment_attempt_log ─────────

  test('payment_attempt_log: PUBLIC cannot UPDATE or DELETE (append-only enforcement)', async () => {
    await G.assertAppendOnlyRevoked(appPool);
  });

  // ── 7. Tenant isolation on payment_attempt_log ────────────────────────────

  test('paymentAttemptLogDb: tenant A rows invisible to tenant B under RLS', async () => {
    const { a, b } = await seedTwo();
    const { reservationId } = await seedReservation(adminPool, a.tenantId, a.propertyId);

    const logA = buildPaymentAttemptLogDb({ db: H.tenantBoundPool(URL, a.tenantId) });
    const logB = buildPaymentAttemptLogDb({ db: H.tenantBoundPool(URL, b.tenantId) });

    await logA.insert({
      tenant_id: a.tenantId, property_id: a.propertyId,
      reservation_id: reservationId, provider: 'mock',
      amount: 100, currency: 'USD', status: 'initiated',
    }, { tenantId: a.tenantId });

    const rows = await logB.listByReservation(reservationId, { tenantId: b.tenantId });
    assert.equal(rows.length, 0, 'tenant B must not see tenant A attempt log rows');
  });

  // ── 8. findExpiredHolds returns only expired pending rows ─────────────────

  test('paymentStateStoreDb.findExpiredHolds: returns expired pending_payment only', async () => {
    const { a } = await seedTwo();
    const { reservationId: expiredId } = await seedReservation(adminPool, a.tenantId, a.propertyId);
    const { reservationId: activeId  } = await seedReservation(adminPool, a.tenantId, a.propertyId);
    const { reservationId: paidId    } = await seedReservation(adminPool, a.tenantId, a.propertyId);

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

    assert.equal(expired.length, 1, 'only the expired pending_payment row should be returned');
    assert.equal(expired[0].reservation_id, expiredId);
    await tPool.end();
  });

  // ── 9. FORCE RLS returns zero rows when GUC not set ──────────────────────

  test('paymentStateStoreDb.findExpiredHolds: FORCE RLS → zero rows when app.tenant_id not set', async () => {
    const { a } = await seedTwo();
    const { reservationId } = await seedReservation(adminPool, a.tenantId, a.propertyId);

    // Use tenant-bound pool to insert
    const tPool = H.tenantBoundPool(URL, a.tenantId);
    const storeT = buildPaymentStateStoreDb({ db: tPool });
    await storeT.upsert({
      tenant_id: a.tenantId, property_id: a.propertyId, reservation_id: reservationId,
      payment_status: 'pending_payment', deposit_amount: 50, deposit_currency: 'USD',
      provider: 'mock', hold_expires_at: new Date(Date.now() - 1000).toISOString(),
    }, { tenantId: a.tenantId });

    // Now query with a pool that has NO tenant context set (raw appPool)
    // FORCE RLS on booking_payment_state with app_current_tenant() returning NULL
    // means zero rows should come back — not an error, just empty.
    const storeRaw = buildPaymentStateStoreDb({ db: appPool });
    const rows = await storeRaw.findExpiredHolds(); // no client param → uses raw pool
    // Under FORCE RLS with no GUC: zero rows (RLS policy filters all out)
    assert.equal(rows.length, 0, 'FORCE RLS must return zero rows when app.tenant_id is not set');

    await tPool.end();
  });

  // ── 10. All tenant tables (including new payment tables) pass RLS guard ───

  test('assertAllTenantTablesSecured: booking_payment_state and payment_attempt_log have FORCE RLS', async () => {
    const count = await G.assertAllTenantTablesSecured(appPool);
    assert.ok(count > 0, 'at least one tenant-scoped table must exist');
  });

}
