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
    const result = await db.query(
      'SELECT * FROM booking_payment_state WHERE reservation_id = $1 LIMIT 1',
      [reservationId]
    );
    return result.rows[0] || null;
  }

  async function findExpiredHolds(ctx = {}) {
    const result = await db.query(
      `SELECT * FROM booking_payment_state
       WHERE payment_status = 'pending_payment' AND hold_expires_at < now()`,
      []
    );
    return result.rows;
  }

  async function deleteByReservationId(reservationId, ctx = {}) {
    await db.query('DELETE FROM booking_payment_state WHERE reservation_id = $1', [reservationId]);
  }

  return { upsert, getByReservationId, findExpiredHolds, deleteByReservationId };
}

module.exports = { buildPaymentStateStoreDb };
