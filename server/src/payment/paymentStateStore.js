'use strict';
const { randomUUID } = require('crypto');

function buildPaymentStateStoreMemory() {
  // keyed by reservation_id
  const _store = new Map();

  async function upsert(record) {
    const existing = _store.get(record.reservation_id);
    const now = new Date().toISOString();
    const row = Object.assign({}, existing || { id: randomUUID(), created_at: now }, record, { updated_at: now });
    _store.set(record.reservation_id, row);
    return row;
  }

  async function getByReservationId(reservationId) {
    return _store.get(reservationId) || null;
  }

  function findExpiredHolds() {
    const now = Date.now();
    return Array.from(_store.values()).filter(r =>
      r.payment_status === 'pending_payment' &&
      r.hold_expires_at &&
      new Date(r.hold_expires_at).getTime() < now
    );
  }

  function deleteByReservationId(reservationId) {
    _store.delete(reservationId);
  }

  return { upsert, getByReservationId, findExpiredHolds, deleteByReservationId };
}

module.exports = { buildPaymentStateStoreMemory };
