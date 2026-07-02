'use strict';

/**
 * channelSyncQueue (Phase 24 S3) - in-memory outbound sync queue.
 *
 * Sits between the Channel Subscriber and the (future) OTA adapters so the flow
 * is `PMS event -> queue -> adapter`, never `PMS event -> adapter`. That
 * decoupling is what makes retries and failure isolation possible later.
 *
 * HARD ISOLATION: in-memory ONLY. No OTA calls, no network, no DB/persistence.
 * Deterministic given an injected clock + id generator, so it is fully testable.
 *
 * Item shape: { id, reservation_id, action, channel, payload, status, created_at }
 * Status:     PENDING -> PROCESSING -> COMPLETED | FAILED
 * Dedupe:     a (reservation_id + action) that is currently PENDING cannot be
 *             enqueued twice. Once it leaves PENDING the key is free again.
 */

const STATUS = Object.freeze({
  PENDING:    'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED:  'COMPLETED',
  FAILED:     'FAILED'
});

function dedupeKey(reservation_id, action) {
  return String(reservation_id) + '::' + String(action);
}

function buildChannelSyncQueue({ clock = () => Date.now(), idGen } = {}) {
  const items       = new Map();   // id -> item
  const order       = [];          // FIFO ids
  const pendingKeys = new Set();   // dedupe keys for items currently PENDING
  let _seq = 0;
  const nextId = idGen || (() => 'q_' + (++_seq));

  const clone = (it) => (it ? Object.assign({}, it) : null);

  function enqueue(input) {
    if (!input || !input.reservation_id || !input.action) {
      return { accepted: false, reason: 'invalid' };
    }
    const key = dedupeKey(input.reservation_id, input.action);
    if (pendingKeys.has(key)) return { accepted: false, deduped: true, key };

    const item = {
      id:             nextId(),
      reservation_id: input.reservation_id,
      action:         input.action,
      channel:        input.channel != null ? input.channel : null,
      payload:        input.payload != null ? input.payload : null,
      status:         STATUS.PENDING,
      created_at:     clock()
    };
    items.set(item.id, item);
    order.push(item.id);
    pendingKeys.add(key);
    return { accepted: true, item: clone(item) };
  }

  // Any move out of PENDING frees the dedupe key so a later change can re-queue.
  function setStatus(id, status) {
    const it = items.get(id);
    if (!it) return null;
    it.status = status;
    if (status !== STATUS.PENDING) pendingKeys.delete(dedupeKey(it.reservation_id, it.action));
    return clone(it);
  }

  function markProcessing(id) { return setStatus(id, STATUS.PROCESSING); }
  function markCompleted(id)  { return setStatus(id, STATUS.COMPLETED); }
  function markFailed(id)     { return setStatus(id, STATUS.FAILED); }

  /** Next PENDING item (FIFO), atomically moved to PROCESSING. null if none. */
  function dequeue() {
    for (const id of order) {
      const it = items.get(id);
      if (it && it.status === STATUS.PENDING) return markProcessing(id);
    }
    return null;
  }

  function get(id) { return clone(items.get(id)); }

  function list(status) {
    const out = [];
    for (const id of order) {
      const it = items.get(id);
      if (it && (!status || it.status === status)) out.push(clone(it));
    }
    return out;
  }

  function size() { return items.size; }

  function clear() {
    items.clear();
    order.length = 0;
    pendingKeys.clear();
    _seq = 0;
  }

  return { enqueue, dequeue, markProcessing, markCompleted, markFailed, get, list, size, clear };
}

module.exports = { buildChannelSyncQueue, STATUS, dedupeKey };
