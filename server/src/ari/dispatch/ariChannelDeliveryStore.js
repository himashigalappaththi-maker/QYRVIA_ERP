'use strict';

/**
 * Phase 68A — low-level durable per-channel ARI delivery ledger store
 * (ari_outbox_channel_delivery, migration 0091).
 *
 * Mirrors src/ari/outbox/ariOutboxStore.js exactly in shape and discipline:
 * `db` is any { query(text, params) } — in production ALWAYS a tenant-bound
 * transactional client supplied by ./tenantAriChannelDelivery.js (the table
 * is FORCE RLS; a bare-pool call would silently see/affect zero rows). This
 * module performs NO transaction management and NO tenant binding of its
 * own: it validates inputs, fails closed BEFORE any SQL on malformed
 * identity, and issues plain parameterized queries on whatever client it was
 * given.
 *
 * WHY THIS TABLE EXISTS (P0 CLOSED HERE)
 * ────────────────────────────────────────
 * Instruction 031's audit found ariOutboxWorker dispatches ONE row per ARI
 * event with no channel field, so a future multi-channel dispatcher's
 * partial success (e.g. Booking.com succeeded, a second channel failed) had
 * nowhere durable to record "Booking.com is already done" before a retry of
 * the SAME outbox row. This store is that durable record. It does not
 * schedule its own retries — RETRY timing is owned entirely by
 * ari_outbox_store's existing backoff (ariOutboxWorker.computeRetryDelayMs);
 * this store only remembers per-channel outcome so a dispatcher can decide,
 * BEFORE ever calling a provider, whether a channel needs an attempt at all.
 *
 * NO event bus, queue, adapter, transport, network or channel-manager
 * dependency beyond the canonical channel-code CHECK the migration itself
 * enforces — this module stays decoupled from provider/transport code.
 */

const STATUS = Object.freeze({
  PENDING:     'PENDING',
  PROCESSING:  'PROCESSING',
  RETRY:       'RETRY',
  COMPLETED:   'COMPLETED',
  DEAD_LETTER: 'DEAD_LETTER'
});

// Must match the migration's aocd_channel_code_check CHECK exactly — QTCN is
// deliberately excluded (legacy read-only alias, never a value this table
// writes; canonicalChannelCode() must run before anything reaches here).
const CANONICAL_CHANNELS = Object.freeze([
  'BOOKING_COM', 'AGODA', 'EXPEDIA', 'AIRBNB',
  'MAKEMYTRIP', 'GOOGLE', 'TRIPADVISOR', 'QYRVIA_CONNECT'
]);
const CANONICAL_CHANNEL_SET = new Set(CANONICAL_CHANNELS);

const ERROR_CLASS = Object.freeze({
  RETRYABLE:     'RETRYABLE',
  NON_RETRYABLE: 'NON_RETRYABLE'
});

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function fail(message) {
  const e = new Error('ariChannelDeliveryStore: ' + message);
  e.code = 'ARI_CHANNEL_DELIVERY_INVALID';
  return e;
}

function assertUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw fail(name + ' must be a UUID');
}

function assertChannel(channelCode) {
  if (typeof channelCode !== 'string' || !CANONICAL_CHANNEL_SET.has(channelCode)) {
    throw fail('channelCode must be one of the canonical routable channels (got ' + String(channelCode) + ')');
  }
}

function validateEnsureInput(input = {}) {
  const { tenantId, propertyId, ariOutboxId, channelCode, dedupeKey, sourceVersion } = input;
  assertUuid(tenantId, 'tenantId');
  assertUuid(propertyId, 'propertyId');
  assertUuid(ariOutboxId, 'ariOutboxId');
  assertChannel(channelCode);
  if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) throw fail('dedupeKey must be a non-empty string');
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) throw fail('sourceVersion must be a positive integer');
  return { tenantId, propertyId, ariOutboxId, channelCode, dedupeKey, sourceVersion };
}

function buildAriChannelDeliveryStore({ db } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('ariChannelDeliveryStore: db.query required');

  return {
    /**
     * Idempotent durable creation. ON CONFLICT targets uq_aocd_event_channel
     * (tenant_id, ari_outbox_id, channel_code) — the narrowest correct
     * identity (see migration 0091 header): one row per tenant / outbox
     * event / canonical channel, across EVERY status (no status predicate),
     * so a redelivery attempt never creates a second row for a channel that
     * already reached COMPLETED or DEAD_LETTER. Atomic INSERT ... ON
     * CONFLICT — no race-prone SELECT-then-INSERT.
     */
    async ensureDelivery(input) {
      const v = validateEnsureInput(input);
      const ins = await db.query(
        `INSERT INTO ari_outbox_channel_delivery
           (tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version, status)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING')
         ON CONFLICT (tenant_id, ari_outbox_id, channel_code)
         DO NOTHING
         RETURNING *`,
        [v.tenantId, v.propertyId, v.ariOutboxId, v.channelCode, v.dedupeKey, v.sourceVersion]
      );
      if (ins.rows[0]) return { created: true, row: ins.rows[0] };
      const existing = await db.query(
        `SELECT * FROM ari_outbox_channel_delivery
          WHERE tenant_id = $1 AND ari_outbox_id = $2 AND channel_code = $3`,
        [v.tenantId, v.ariOutboxId, v.channelCode]
      );
      return { created: false, row: existing.rows[0] || null };
    },

    /** Every durable delivery row for one ARI outbox event (RLS supplies the tenant predicate). */
    async listForOutboxEvent(ariOutboxId) {
      assertUuid(ariOutboxId, 'ariOutboxId');
      const r = await db.query(
        'SELECT * FROM ari_outbox_channel_delivery WHERE ari_outbox_id = $1 ORDER BY channel_code',
        [ariOutboxId]
      );
      return r.rows;
    },

    async get(id) {
      assertUuid(id, 'id');
      const r = await db.query('SELECT * FROM ari_outbox_channel_delivery WHERE id = $1', [id]);
      return r.rows[0] || null;
    },

    /**
     * PENDING|RETRY -> PROCESSING. FOR UPDATE so a concurrent claimer of the
     * SAME row never double-claims. A COMPLETED or DEAD_LETTER row (or one
     * already PROCESSING) is never reclaimed — returns null.
     */
    async claim(id) {
      assertUuid(id, 'id');
      const r = await db.query(
        `UPDATE ari_outbox_channel_delivery
            SET status = 'PROCESSING', last_attempt_at = now(), updated_at = now()
          WHERE id = (
            SELECT id FROM ari_outbox_channel_delivery
             WHERE id = $1 AND status IN ('PENDING','RETRY')
             FOR UPDATE SKIP LOCKED
          )
        RETURNING *`,
        [id]
      );
      return r.rows[0] || null;
    },

    /** PROCESSING -> COMPLETED (terminal). Records the provider's own ack id, never a secret. */
    async markCompleted(id, { providerAckId = null } = {}) {
      assertUuid(id, 'id');
      const r = await db.query(
        `UPDATE ari_outbox_channel_delivery
            SET status = 'COMPLETED', provider_ack_id = $2,
                completed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING'
        RETURNING *`,
        [id, providerAckId]
      );
      return r.rows[0] || null;
    },

    /**
     * PROCESSING -> RETRY. attempt_count increments exactly once per
     * finished (non-crashed) attempt — mirrors ari_outbox_store's own
     * attempts/retry_count discipline. Timing of the NEXT attempt is NOT
     * this table's concern (see module header); the outer ari_outbox_store
     * row owns backoff scheduling.
     */
    async markRetry(id, { errorCode = null, errorClass = ERROR_CLASS.RETRYABLE } = {}) {
      assertUuid(id, 'id');
      if (errorClass !== ERROR_CLASS.RETRYABLE && errorClass !== ERROR_CLASS.NON_RETRYABLE) {
        throw fail('errorClass must be RETRYABLE or NON_RETRYABLE');
      }
      const r = await db.query(
        `UPDATE ari_outbox_channel_delivery
            SET status = 'RETRY', attempt_count = attempt_count + 1,
                last_error_code = $2, last_error_class = $3, updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING'
        RETURNING *`,
        [id, errorCode, errorClass]
      );
      return r.rows[0] || null;
    },

    /** PROCESSING -> DEAD_LETTER (terminal). attempt_count increments exactly once. */
    async markDeadLetter(id, { errorCode = null, errorClass = ERROR_CLASS.NON_RETRYABLE } = {}) {
      assertUuid(id, 'id');
      const r = await db.query(
        `UPDATE ari_outbox_channel_delivery
            SET status = 'DEAD_LETTER', attempt_count = attempt_count + 1,
                last_error_code = $2, last_error_class = $3, updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING'
        RETURNING *`,
        [id, errorCode, errorClass]
      );
      return r.rows[0] || null;
    }
  };
}

/**
 * PURE helper (no I/O): given the durable rows already fetched for one ARI
 * outbox event and the set of channels this dispatch requires, decide
 * whether every required channel is durably COMPLETED. Exported so the
 * dispatcher never re-derives this logic ad hoc.
 */
function allRequiredChannelsComplete(rows, requiredChannelCodes) {
  const completed = new Set(
    (rows || []).filter((r) => r && r.status === STATUS.COMPLETED).map((r) => r.channel_code)
  );
  return (requiredChannelCodes || []).every((c) => completed.has(c));
}

module.exports = {
  buildAriChannelDeliveryStore,
  allRequiredChannelsComplete,
  STATUS,
  ERROR_CLASS,
  CANONICAL_CHANNELS
};
