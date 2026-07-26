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

  /**
   * Phase 63 P0-8 — atomic compare-and-set out of 'pending_payment'.
   *
   * `upsert` is an unconditional write, so confirmBooking and the hold-expiry
   * sweep could both act on the same hold: confirm reads pending, the sweep
   * flips it to failed and cancels the reservation, and confirm then charges
   * the guest for a reservation that no longer exists. Exactly one caller must
   * be able to leave 'pending_payment'.
   *
   * @returns the updated row, or null if the hold was already claimed.
   */
  async function transitionPending(reservationId, toStatus, patch = {}) {
    const existing = _store.get(reservationId);
    if (!existing || existing.payment_status !== 'pending_payment') return null;
    const now = new Date().toISOString();
    const row = Object.assign({}, existing, patch, { payment_status: toStatus, updated_at: now });
    _store.set(reservationId, row);
    return row;
  }

  return { upsert, getByReservationId, findExpiredHolds, deleteByReservationId, transitionPending };
}

module.exports = { buildPaymentStateStoreMemory };
