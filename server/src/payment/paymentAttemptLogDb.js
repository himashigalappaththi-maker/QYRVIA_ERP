'use strict';

function buildPaymentAttemptLogDb({ db }) {
  if (!db) throw new Error('paymentAttemptLogDb: db required');

  async function insert(entry, ctx = {}) {
    const result = await db.query(`
      INSERT INTO payment_attempt_log
        (tenant_id, property_id, reservation_id, provider, amount, currency, status, provider_ref, error_code, error_message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      entry.tenant_id || ctx.tenantId,
      entry.property_id || ctx.propertyId,
      entry.reservation_id,
      entry.provider,
      entry.amount,
      entry.currency,
      entry.status,
      entry.provider_ref || null,
      entry.error_code || null,
      entry.error_message || null,
    ]);
    return result.rows[0];
  }

  async function listByReservation(reservationId, ctx = {}) {
    const result = await db.query(
      'SELECT * FROM payment_attempt_log WHERE reservation_id = $1 ORDER BY created_at DESC',
      [reservationId]
    );
    return result.rows;
  }

  return { insert, listByReservation };
}

module.exports = { buildPaymentAttemptLogDb };
