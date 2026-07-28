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

/**
 * PHASE 65 C3 — the dedupe key must include the CHANNEL (and the tenant).
 *
 * The key used to be `reservation_id::action`. With per-OTA fan-out that is
 * catastrophic: one event fanning out to eight channels produces eight jobs
 * that all collapse onto a single key, so seven channels are silently deduped
 * away and never synced. The key must identify the job, and a job is
 * (tenant, reservation, action, channel).
 *
 * `channel` and `tenant_id` are optional so the two-argument legacy call still
 * produces a stable key; they widen the key rather than changing its meaning.
 */
function dedupeKey(reservation_id, action, channel, tenant_id) {
  return [
    tenant_id == null ? '*' : String(tenant_id),
    String(reservation_id),
    String(action),
    channel == null ? '*' : String(channel)
  ].join('::');
}

function keyOf(item) {
  return dedupeKey(item.reservation_id, item.action, item.channel, item.tenant_id);
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
    const key = dedupeKey(input.reservation_id, input.action, input.channel, input.tenant_id);
    if (pendingKeys.has(key)) return { accepted: false, deduped: true, key };

    const item = {
      id:             nextId(),
      // Phase 65 C2: trusted identity travels with the job.
      tenant_id:      input.tenant_id != null ? input.tenant_id : null,
      property_id:    input.property_id != null ? input.property_id : null,
      actor_id:       input.actor_id != null ? input.actor_id : null,
      request_id:     input.request_id != null ? input.request_id : null,
      event_id:       input.event_id != null ? input.event_id : null,
      event_type:     input.event_type != null ? input.event_type : null,
      aggregate_type: input.aggregate_type != null ? input.aggregate_type : null,
      aggregate_id:   input.aggregate_id != null ? input.aggregate_id : null,
      occurred_at:    input.occurred_at != null ? input.occurred_at : null,
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
    if (status !== STATUS.PENDING) pendingKeys.delete(keyOf(it));
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
