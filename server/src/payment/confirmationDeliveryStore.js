'use strict';

/**
 * Phase 56 — In-memory confirmation delivery store.
 * Used in unit tests and as a fallback in non-DB environments.
 *
 * Implements the same interface as the DB-backed confirmationDeliveryRepo:
 *   insertBookingConfirmationDelivery(row) -> row
 *   claimPendingConfirmationDeliveries({ limit, workerId }) -> row[]
 *   markConfirmationDeliveryStatus(id, status, opts) -> void
 *   findConfirmationDeliveryByDedupKey(tenantId, dedupKey) -> row|null
 */

function buildConfirmationDeliveryStoreMemory() {
  const _rows = new Map();

  function _get(id) { return _rows.get(id) || null; }
  function _all() { return Array.from(_rows.values()); }

  function insertBookingConfirmationDelivery(rec) {
    // Enforce uniqueness on (tenant_id, dedup_key)
    const dup = _all().find(r => r.tenant_id === rec.tenant_id && r.dedup_key === rec.dedup_key);
    if (dup) {
      const err = new Error('unique_violation');
      err.code = '23505';
      throw err;
    }
    const row = Object.assign({
      id:            'bcd-' + Math.random().toString(36).slice(2, 10),
      status:        'pending',
      attempt_count: 0,
      max_attempts:  3,
      next_attempt_at: null,
      last_error:    null,
      provider_ref:  null,
      locked_by:     null,
      locked_at:     null,
      sent_at:       null,
      created_at:    new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    }, rec);
    _rows.set(row.id, row);
    return row;
  }

  function claimPendingConfirmationDeliveries({ limit = 25, workerId } = {}) {
    const now = new Date();
    const due = _all().filter(r => {
      if (r.status !== 'pending') return false;
      if (r.next_attempt_at && new Date(r.next_attempt_at) > now) return false;
      return true;
    }).slice(0, limit);

    for (const r of due) {
      const updated = Object.assign({}, r, { status: 'processing', locked_by: workerId || null, locked_at: now.toISOString(), updated_at: now.toISOString() });
      _rows.set(r.id, updated);
    }
    return due.map(r => _rows.get(r.id));
  }

  function markConfirmationDeliveryStatus(id, status, { sentAt, providerRef, attemptCount, lastError, nextAttemptAt } = {}) {
    const row = _get(id);
    if (!row) return;
    const now = new Date().toISOString();
    const updated = Object.assign({}, row, {
      status,
      updated_at:       now,
      locked_by:        null,
      locked_at:        null,
    });
    if (sentAt !== undefined)       updated.sent_at       = sentAt instanceof Date ? sentAt.toISOString() : sentAt;
    if (providerRef !== undefined)  updated.provider_ref  = providerRef;
    if (attemptCount !== undefined) updated.attempt_count = attemptCount;
    if (lastError !== undefined)    updated.last_error    = lastError;
    if (nextAttemptAt !== undefined) {
      updated.next_attempt_at = nextAttemptAt instanceof Date ? nextAttemptAt.toISOString() : nextAttemptAt;
      if (status === 'retryable_failure') updated.status = 'pending';
    }
    _rows.set(id, updated);
  }

  function findConfirmationDeliveryByDedupKey(tenantId, dedupKey) {
    return _all().find(r => r.tenant_id === tenantId && r.dedup_key === dedupKey) || null;
  }

  function _list() { return _all(); }

  return {
    insertBookingConfirmationDelivery,
    claimPendingConfirmationDeliveries,
    markConfirmationDeliveryStatus,
    findConfirmationDeliveryByDedupKey,
    _list,
  };
}

module.exports = { buildConfirmationDeliveryStoreMemory };
