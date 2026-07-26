'use strict';

function buildPaymentStateStoreDb({ db }) {
  if (!db) throw new Error('paymentStateStoreDb: db required');

  async function upsert(record, ctx = {}) {
    const tenantId = record.tenant_id || ctx.tenantId;
    const result = await db.query(`
      INSERT INTO booking_payment_state
        (tenant_id, property_id, reservation_id, payment_status, deposit_amount, deposit_currency,
         hold_expires_at, provider, provider_ref, paid_at, failed_at, refunded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (reservation_id) DO UPDATE SET
        payment_status  = EXCLUDED.payment_status,
        deposit_amount  = COALESCE(EXCLUDED.deposit_amount, booking_payment_state.deposit_amount),
        deposit_currency= COALESCE(EXCLUDED.deposit_currency, booking_payment_state.deposit_currency),
        hold_expires_at = COALESCE(EXCLUDED.hold_expires_at, booking_payment_state.hold_expires_at),
        provider        = COALESCE(EXCLUDED.provider, booking_payment_state.provider),
        provider_ref    = COALESCE(EXCLUDED.provider_ref, booking_payment_state.provider_ref),
        paid_at         = COALESCE(EXCLUDED.paid_at, booking_payment_state.paid_at),
        failed_at       = COALESCE(EXCLUDED.failed_at, booking_payment_state.failed_at),
        refunded_at     = COALESCE(EXCLUDED.refunded_at, booking_payment_state.refunded_at),
        updated_at      = now()
      RETURNING *
    `, [
      tenantId,
      record.property_id || ctx.propertyId,
      record.reservation_id,
      record.payment_status,
      record.deposit_amount || null,
      record.deposit_currency || null,
      record.hold_expires_at || null,
      record.provider || null,
      record.provider_ref || null,
      record.paid_at || null,
      record.failed_at || null,
      record.refunded_at || null,
    ]);
    return result.rows[0] || null;
  }

  async function getByReservationId(reservationId, ctx = {}) {
    const tenantId = (ctx && ctx.tenantId) || null;
    if (tenantId) {
      // Explicit tenant filter satisfies the Continue.txt tightening requirement:
      // every request-path and sweep-path call must prove tenant scope rather than
      // relying solely on RLS. FORCE RLS is a second layer, not the primary guard.
      const result = await db.query(
        'SELECT * FROM booking_payment_state WHERE reservation_id = $1 AND tenant_id = $2 LIMIT 1',
        [reservationId, tenantId]
      );
      return result.rows[0] || null;
    }
    const result = await db.query(
      'SELECT * FROM booking_payment_state WHERE reservation_id = $1 LIMIT 1',
      [reservationId]
    );
    return result.rows[0] || null;
  }

  // client param: when provided (e.g. from withTenant() in the sweep handler), the
  // query runs inside that transaction's RLS context so FORCE RLS returns the correct
  // tenant's rows. When omitted (e.g. in unit tests using the memory store fallback),
  // the raw pool is used — under FORCE RLS this returns zero rows, which is safe.
  async function findExpiredHolds(client) {
    const executor = client || db;
    const result = await executor.query(
      `SELECT * FROM booking_payment_state
       WHERE payment_status = 'pending_payment' AND hold_expires_at < now()`,
      []
    );
    return result.rows;
  }

  async function deleteByReservationId(reservationId, ctx = {}) {
    await db.query('DELETE FROM booking_payment_state WHERE reservation_id = $1', [reservationId]);
  }

  /**
   * Phase 63 P0-8 — atomic compare-and-set out of 'pending_payment'.
   *
   * `upsert` is an unconditional ON CONFLICT DO UPDATE, so it is NOT a CAS.
   * That let confirmBooking and the hold-expiry sweep both act on one hold:
   * confirm read 'pending', the sweep flipped it to 'failed' and cancelled the
   * PMS reservation, and confirm then verified (charged) the payment against a
   * cancelled reservation — money taken, no room.
   *
   * The `WHERE payment_status = 'pending_payment'` predicate makes the
   * transition single-winner at the database level. The loser gets null.
   *
   * @param {string} reservationId
   * @param {'paid'|'failed'|'refunded'} toStatus
   * @param {object} patch  optional timestamp/provider columns to set
   * @param {object} ctx    must carry tenantId (explicit scope, not just RLS)
   * @returns {Promise<object|null>} the updated row, or null if already claimed
   */
  async function transitionPending(reservationId, toStatus, patch = {}, ctx = {}) {
    const tenantId = (ctx && ctx.tenantId) || null;
    const params = [reservationId, toStatus,
      patch.paid_at || null, patch.failed_at || null, patch.refunded_at || null, patch.provider_ref || null];
    let sql = `
      UPDATE booking_payment_state
         SET payment_status = $2,
             paid_at      = COALESCE($3::timestamptz, paid_at),
             failed_at    = COALESCE($4::timestamptz, failed_at),
             refunded_at  = COALESCE($5::timestamptz, refunded_at),
             provider_ref = COALESCE($6::varchar, provider_ref),
             updated_at   = now()
       WHERE reservation_id = $1
         AND payment_status = 'pending_payment'`;
    if (tenantId) { sql += ` AND tenant_id = $7`; params.push(tenantId); }
    sql += ` RETURNING *`;
    const result = await db.query(sql, params);
    return result.rows[0] || null;
  }

  return { upsert, getByReservationId, findExpiredHolds, deleteByReservationId, transitionPending };
}

module.exports = { buildPaymentStateStoreDb };
