'use strict';

/**
 * Lease-capable in-memory job queue (Phase 24 B6) - the durable-semantics queue
 * the worker polls. Models lease + retry fields so processing is worker-safe and
 * crash-safe:
 *   lease_owner, lease_expires_at  -> exclusive claim; expired lease is recoverable
 *   retry_count, next_retry_at     -> backoff scheduling
 *
 * Status: PENDING -> PROCESSING -> COMPLETED | DEAD_LETTER. A retry returns a job
 * to PENDING with next_retry_at set. Single-threaded JS makes lease/transition
 * operations atomic. No I/O, no OTA, deterministic with an injected clock.
 */

const STATUS = Object.freeze({ PENDING: 'PENDING', PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED', DEAD_LETTER: 'DEAD_LETTER' });

function buildLeaseQueue({ clock = () => Date.now(), idGen } = {}) {
  const items = new Map();
  const order = [];
  let _seq = 0;
  const nid = idGen || (() => 'wj_' + (++_seq));
  const clone = (o) => (o ? Object.assign({}, o) : null);

  function enqueue(input) {
    if (!input || !input.reservation_id || !input.action) return { accepted: false, reason: 'invalid' };
    const item = {
      id: nid(),
      tenant_id: input.tenant_id || null,
      reservation_id: input.reservation_id,
      action: input.action,
      channel: input.channel != null ? input.channel : null,
      payload: input.payload != null ? input.payload : null,
      status: STATUS.PENDING,
      retry_count: 0,
      next_retry_at: null,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
      created_at: clock()
    };
    items.set(item.id, item);
    order.push(item.id);
    return { accepted: true, item: clone(item) };
  }

  // Claim the next eligible PENDING job (FIFO): backoff elapsed + not actively leased.
  function leaseNext(owner, leaseMs, now) {
    for (const id of order) {
      const it = items.get(id);
      if (!it || it.status !== STATUS.PENDING) continue;
      if (it.next_retry_at != null && it.next_retry_at > now) continue; // still backing off
      it.status = STATUS.PROCESSING;
      it.lease_owner = owner;
      it.lease_expires_at = now + leaseMs;
      return clone(it);
    }
    return null;
  }

  // Only the current lease owner may transition a PROCESSING job (prevents a
  // resurrected/stale worker from acting on a job re-leased by another).
  function _owned(id, owner) {
    const it = items.get(id);
    if (!it || it.status !== STATUS.PROCESSING) return null;
    if (owner != null && it.lease_owner !== owner) return null;
    return it;
  }

  function markCompleted(id, owner) {
    const it = _owned(id, owner); if (!it) return null;
    it.status = STATUS.COMPLETED; it.lease_owner = null; it.lease_expires_at = null;
    return clone(it);
  }
  function markFailedRetry(id, owner, nextRetryAt) {
    const it = _owned(id, owner); if (!it) return null;
    it.retry_count += 1; it.next_retry_at = nextRetryAt; it.status = STATUS.PENDING;
    it.lease_owner = null; it.lease_expires_at = null;
    return clone(it);
  }
  function markDeadLetter(id, owner, reason) {
    const it = _owned(id, owner); if (!it) return null;
    it.status = STATUS.DEAD_LETTER; it.last_error = reason || it.last_error;
    it.lease_owner = null; it.lease_expires_at = null;
    return clone(it);
  }

  // Crash recovery: PROCESSING jobs whose lease elapsed return to PENDING.
  function recoverExpired(now) {
    const recovered = [];
    for (const it of items.values()) {
      if (it.status === STATUS.PROCESSING && it.lease_expires_at != null && it.lease_expires_at <= now) {
        it.status = STATUS.PENDING; it.lease_owner = null; it.lease_expires_at = null;
        recovered.push(it.id);
      }
    }
    return recovered;
  }

  function get(id) { return clone(items.get(id)); }
  function list(status) { const out = []; for (const id of order) { const it = items.get(id); if (it && (!status || it.status === status)) out.push(clone(it)); } return out; }
  function counts() {
    const c = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, DEAD_LETTER: 0 };
    for (const it of items.values()) c[it.status] = (c[it.status] || 0) + 1;
    return c;
  }
  function size() { return items.size; }
  function clear() { items.clear(); order.length = 0; _seq = 0; }

  return { enqueue, leaseNext, markCompleted, markFailedRetry, markDeadLetter, recoverExpired, get, list, counts, size, clear };
}

module.exports = { buildLeaseQueue, STATUS };
