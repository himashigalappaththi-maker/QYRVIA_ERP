'use strict';

/**
 * Phase 66A-B2N-B — low-level ARI outbox store (ari_outbox_store, migration
 * 0087).
 *
 * `db` is any { query(text, params) } — in production ALWAYS a tenant-bound
 * transactional client supplied by src/ari/outbox/tenantAriOutbox.js (the
 * table is FORCE RLS; a bare-pool call would silently see/affect zero rows,
 * which is exactly the P0-11 defect class B2N-A eliminated for the ARI
 * store). This module performs NO transaction management and NO tenant
 * binding of its own: it validates inputs, fails closed BEFORE any SQL when
 * identity is missing or malformed, and issues plain parameterized queries
 * on whatever client it was given — so an enqueue can share the exact same
 * transaction as the authoritative ARI mutation it describes (the B2N-C
 * invariant this phase prepares for).
 *
 * Retry model mirrors B2M (dbStores.js sync queue + migration 0086): a
 * scheduled retry stays PENDING with next_retry_at in the future — there is
 * no RETRY_WAIT status. Claiming does NOT increment attempts (matching the
 * queue's claim semantics); attempts increments exactly once per terminal
 * outcome of a processing attempt (markRetryScheduled / markDeadLetter).
 * markDeadLetter preserves retry_count as-is (B2M semantics: the number of
 * retries scheduled before the exhausting/non-retryable failure).
 *
 * Lease lifecycle (B2N-B pre-application correction #2): a worker that
 * crashes after claiming would leave its row PROCESSING forever, so
 * requeueExpiredLeases() returns PROCESSING rows whose lease_until has
 * passed to PENDING (lease cleared). retry_count AND attempts are both
 * preserved: attempts counts processing attempts a live worker FINISHED and
 * reported (markRetryScheduled/markDeadLetter) — a crashed worker reported
 * nothing, so lease expiry is deliberately NOT a completed attempt. A row
 * whose lease is still active is never recovered. Recovery only flips the
 * status of the SAME row (no insert), so it cannot create a duplicate
 * row under the global uq_aob_logical_event constraint.
 *
 * IDEMPOTENCY REQUIREMENT FOR FUTURE TRANSPORT (B2N-C+): a worker may have
 * completed its external side effect and then crashed (or lost its lease)
 * before reporting — the recovered row WILL be processed again. Any
 * downstream channel delivery built on this outbox must therefore be
 * idempotent per (dedupe_key, source_version).
 *
 * NO event bus, queue, adapter, transport, network or channel-manager
 * dependency — this module must stay decoupled from reservation identifiers
 * and provider code entirely.
 */

const crypto = require('node:crypto');

const EVENT_TYPES = Object.freeze({
  AVAILABILITY_CHANGED: 'AVAILABILITY_CHANGED',
  RATE_CHANGED:         'RATE_CHANGED',
  INVENTORY_CHANGED:    'INVENTORY_CHANGED'
});

// RATE and INVENTORY align with the canonical RESOURCE enum
// (channel-manager/core/canonical/types.js) by NAME ONLY — deliberately not
// imported from there, so the outbox has zero channel-manager coupling.
// AVAILABILITY is new: the canonical enum does not carry it yet.
const RESOURCE_KINDS = Object.freeze({
  AVAILABILITY: 'AVAILABILITY',
  RATE:         'RATE',
  INVENTORY:    'INVENTORY'
});

const EVENT_RESOURCE = Object.freeze({
  AVAILABILITY_CHANGED: 'AVAILABILITY',
  RATE_CHANGED:         'RATE',
  INVENTORY_CHANGED:    'INVENTORY'
});

const STATUS = Object.freeze({
  PENDING:     'PENDING',
  PROCESSING:  'PROCESSING',
  COMPLETED:   'COMPLETED',
  DEAD_LETTER: 'DEAD_LETTER'
});

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Secret material must never be persisted in payload_json. Key-name scan,
// case-insensitive, applied recursively — fail closed on any match.
const SECRET_KEY_RE = /(password|passwd|secret|token|credential|api[_-]?key|authorization|private[_-]?key)/i;

function fail(message) {
  const e = new Error('ariOutboxStore: ' + message);
  e.code = 'ARI_OUTBOX_INVALID';
  return e;
}

function assertNoSecretKeys(value, trail) {
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) {
      throw fail('payload must not contain secret material (rejected key "' + trail + k + '")');
    }
    assertNoSecretKeys(v, trail + k + '.');
  }
}

/**
 * Deterministic, COLLISION-SAFE logical dedupe identity (B2N-B final
 * dedupe-encoding correction). The full identity is
 * (tenant_id, property_id, dedupe_key) — tenant and property are separate
 * columns of the global uq_aob_logical_event constraint, and this key
 * covers the rest.
 *
 * Encoding: an ORDERED canonical tuple
 *   [eventType, resourceKind, roomTypeId, ratePlanId-or-null,
 *    effectiveFrom, effectiveTo, sourceVersion]
 * is serialized with JSON.stringify (array order is explicit and
 * deterministic — this is NOT an unordered-object serialization) and the
 * exact canonical bytes are hashed with SHA-256:
 *
 *   aob:v1:<lowercase-hex-sha256>
 *
 * Because every component is a distinct JSON array element, identifiers
 * containing '|', ':', quotes, slashes, Unicode or whitespace can never
 * collide through component-boundary ambiguity (the defect of the previous
 * raw '|'-delimited format), and a null ratePlanId is a distinct JSON value
 * from any literal string. The key deliberately excludes payload JSON,
 * random UUIDs, unrelated timestamps, tenant/property (already columns of
 * the unique constraint) and secrets. Same logical mutation -> same key
 * (deduplicated in EVERY status); a later source version or different
 * effective period -> a different key.
 */
function buildAriDedupeKey({ eventType, resourceKind, roomTypeId, ratePlanId, effectiveFrom, effectiveTo, sourceVersion }) {
  const kind = resourceKind === undefined ? EVENT_RESOURCE[eventType] : resourceKind;
  const canonicalTuple = [
    eventType,
    kind,
    roomTypeId,
    ratePlanId != null ? ratePlanId : null,
    effectiveFrom,
    effectiveTo,
    sourceVersion
  ];
  const canonicalBytes = JSON.stringify(canonicalTuple);
  return 'aob:v1:' + crypto.createHash('sha256').update(canonicalBytes, 'utf8').digest('hex');
}

/**
 * Phase 66A-B2N-C2 — the RESTRICTION-RULE identity (key version 2).
 *
 * v1 cannot express a restriction rule: it has no slot for the rule's own
 * identity (so two distinct rules over the same scope, dates and version
 * collide), and it cannot represent a property-wide or rate-plan-only rule
 * at all. v2 is therefore a SEPARATE, additional identity — v1's tuple,
 * arity, prefix and meaning are untouched and still used by every
 * non-restriction event.
 *
 * Encoding matches v1's discipline exactly: an ORDERED canonical array is
 * serialized with JSON.stringify and the exact bytes hashed with SHA-256.
 * Every element is either a literal, the rule's IMMUTABLE id, a persisted
 * scope dimension, or the database-assigned version — never a payload
 * value, timestamp, request id or random UUID. The literal
 * 'RESTRICTION_RULE' discriminator means a v2 restriction identity can never
 * be confused with any future v2 resource, and the differing key prefix
 * makes a v1/v2 collision impossible.
 *
 *   aob:v2:<lowercase-hex-sha256>
 */
function buildAriRestrictionDedupeKey({ restrictionRuleId, level, roomTypeId, ratePlanId, channel, effectiveFrom, effectiveTo, sourceVersion }) {
  const canonicalTuple = [
    EVENT_TYPES.AVAILABILITY_CHANGED,
    RESOURCE_KINDS.AVAILABILITY,
    'RESTRICTION_RULE',
    restrictionRuleId,
    level,
    roomTypeId != null ? roomTypeId : null,
    ratePlanId != null ? ratePlanId : null,
    channel != null ? channel : null,
    effectiveFrom,
    effectiveTo,
    sourceVersion
  ];
  return 'aob:v2:' + crypto.createHash('sha256').update(JSON.stringify(canonicalTuple), 'utf8').digest('hex');
}

// Persisted ari_restriction_rule.level values (migration 0049's CHECK).
const RESTRICTION_LEVELS = Object.freeze(['system', 'property', 'rate_plan', 'channel']);

function optionalNonEmptyString(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0) throw fail(name + ' must be a non-empty string when present');
  return value;
}

/**
 * Validates a RESTRICTION enqueue (key version 2) and returns the normalized
 * row values. Fails closed BEFORE any SQL on the first violation. A
 * restriction event is identified by a non-empty restrictionRuleId; it is
 * the only event class permitted to omit roomTypeId, and the only
 * AVAILABILITY_CHANGED event permitted to carry a ratePlanId.
 */
function validateRestrictionEnqueueInput(input) {
  const {
    tenantId, propertyId, eventType, resourceKind, restrictionRuleId, level,
    roomTypeId, ratePlanId, channel, effectiveFrom, effectiveTo, sourceVersion,
    dedupeKey, payload, maxRetries
  } = input;

  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw fail('tenantId must be a UUID');
  if (typeof propertyId !== 'string' || !UUID_RE.test(propertyId)) throw fail('propertyId must be a UUID');

  if (eventType !== EVENT_TYPES.AVAILABILITY_CHANGED) {
    throw fail('a restriction event must be AVAILABILITY_CHANGED (got ' + eventType + ')');
  }
  const kind = resourceKind === undefined ? RESOURCE_KINDS.AVAILABILITY : resourceKind;
  if (kind !== RESOURCE_KINDS.AVAILABILITY) {
    throw fail('a restriction event must carry resourceKind AVAILABILITY (got ' + kind + ')');
  }

  if (typeof restrictionRuleId !== 'string' || restrictionRuleId.length === 0 || restrictionRuleId.length > 80) {
    throw fail('restrictionRuleId must be a non-empty string of at most 80 characters');
  }
  if (!RESTRICTION_LEVELS.includes(level)) throw fail('level invalid: ' + level);

  const room = optionalNonEmptyString(roomTypeId, 'roomTypeId');
  const plan = optionalNonEmptyString(ratePlanId, 'ratePlanId');
  const chan = optionalNonEmptyString(channel, 'channel');

  if (typeof effectiveFrom !== 'string' || !ISO_DATE.test(effectiveFrom)) throw fail("effectiveFrom must be 'YYYY-MM-DD'");
  if (typeof effectiveTo !== 'string' || !ISO_DATE.test(effectiveTo)) throw fail("effectiveTo must be 'YYYY-MM-DD'");
  if (!(effectiveTo > effectiveFrom)) throw fail('effective period invalid: effectiveTo must be after effectiveFrom (half-open [from, to))');

  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) throw fail('sourceVersion must be a positive integer');

  const body = payload === undefined ? {} : payload;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw fail('payload must be a plain object');
  assertNoSecretKeys(body, '');

  const computedKey = buildAriRestrictionDedupeKey({
    restrictionRuleId, level, roomTypeId: room, ratePlanId: plan, channel: chan,
    effectiveFrom, effectiveTo, sourceVersion
  });
  if (dedupeKey !== undefined && dedupeKey !== computedKey) {
    throw fail('dedupeKey does not match the canonical restriction identity for these fields');
  }

  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw fail('maxRetries must be a non-negative integer when present');
  }

  return {
    tenantId, propertyId,
    eventType: EVENT_TYPES.AVAILABILITY_CHANGED,
    resourceKind: RESOURCE_KINDS.AVAILABILITY,
    restrictionRuleId,
    roomTypeId: room, ratePlanId: plan,
    effectiveFrom, effectiveTo, sourceVersion,
    dedupeKey: computedKey, payload: body,
    maxRetries: maxRetries !== undefined ? maxRetries : null
  };
}

/**
 * Validates every enqueue input and returns the normalized row values.
 * Throws (fails closed) BEFORE any SQL on the first violation.
 */
function validateEnqueueInput(input = {}) {
  const {
    tenantId, propertyId, eventType, resourceKind, roomTypeId, ratePlanId,
    effectiveFrom, effectiveTo, sourceVersion, dedupeKey, payload, maxRetries
  } = input;

  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw fail('tenantId must be a UUID');
  if (typeof propertyId !== 'string' || !UUID_RE.test(propertyId)) throw fail('propertyId must be a UUID');
  if (!Object.prototype.hasOwnProperty.call(EVENT_TYPES, eventType)) throw fail('eventType invalid: ' + eventType);

  const expectedKind = EVENT_RESOURCE[eventType];
  const kind = resourceKind === undefined ? expectedKind : resourceKind;
  if (kind !== expectedKind) throw fail('resourceKind ' + kind + ' incompatible with ' + eventType);

  if (typeof roomTypeId !== 'string' || roomTypeId.length === 0) throw fail('roomTypeId required');

  if (ratePlanId != null && eventType !== EVENT_TYPES.RATE_CHANGED) {
    throw fail('ratePlanId is only valid for RATE_CHANGED events');
  }
  if (ratePlanId != null && (typeof ratePlanId !== 'string' || ratePlanId.length === 0)) {
    throw fail('ratePlanId must be a non-empty string when present');
  }

  if (typeof effectiveFrom !== 'string' || !ISO_DATE.test(effectiveFrom)) throw fail("effectiveFrom must be 'YYYY-MM-DD'");
  if (typeof effectiveTo !== 'string' || !ISO_DATE.test(effectiveTo)) throw fail("effectiveTo must be 'YYYY-MM-DD'");
  if (!(effectiveTo > effectiveFrom)) throw fail('effective period invalid: effectiveTo must be after effectiveFrom (half-open [from, to))');

  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) throw fail('sourceVersion must be a positive integer');

  const body = payload === undefined ? {} : payload;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw fail('payload must be a plain object');
  assertNoSecretKeys(body, '');

  const computedKey = buildAriDedupeKey({
    eventType, resourceKind: kind, roomTypeId,
    ratePlanId: ratePlanId != null ? ratePlanId : null,
    effectiveFrom, effectiveTo, sourceVersion
  });
  if (dedupeKey !== undefined && dedupeKey !== computedKey) {
    throw fail('dedupeKey does not match the canonical identity for these fields');
  }

  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw fail('maxRetries must be a non-negative integer when present');
  }

  return {
    tenantId, propertyId, eventType, resourceKind: kind, roomTypeId,
    ratePlanId: ratePlanId != null ? ratePlanId : null,
    effectiveFrom, effectiveTo, sourceVersion,
    dedupeKey: computedKey, payload: body,
    maxRetries: maxRetries !== undefined ? maxRetries : null
  };
}

function buildAriOutboxStore({ db } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('ariOutboxStore: db.query required');

  return {
    /**
     * Idempotent durable enqueue. ON CONFLICT targets the GLOBAL
     * uq_aob_logical_event constraint (tenant_id, property_id, dedupe_key —
     * no status predicate), so the identical logical event deduplicates in
     * EVERY status: PENDING, PROCESSING, COMPLETED and DEAD_LETTER all
     * return {accepted:false, deduped:true, existing:<that row>} — the
     * documented idempotent-duplicate result. A DEAD_LETTER duplicate is
     * NEVER silently re-inserted: replaying a dead-lettered event is a
     * future explicit, separately-reviewed state-transition operation, not
     * an INSERT (and is not implemented in this phase). A later legitimate
     * source version has a different dedupe_key and creates a new row. The
     * INSERT ... ON CONFLICT is atomic — no race-prone SELECT-then-INSERT;
     * two concurrent enqueues of the same logical event yield exactly one
     * row (the loser reads the winner's row afterwards).
     */
    async enqueue(input) {
      // B2N-C2: a non-empty restrictionRuleId selects the restriction (v2)
      // contract; every other event keeps the unchanged v1 contract. The
      // two validators are disjoint — a restriction event can never be
      // accepted as v1, and a non-restriction event can never be accepted
      // as v2.
      const isRestriction = input && typeof input.restrictionRuleId === 'string' && input.restrictionRuleId.length > 0;
      const v = isRestriction ? validateRestrictionEnqueueInput(input) : validateEnqueueInput(input);
      const restrictionRuleId = isRestriction ? v.restrictionRuleId : null;
      const r = await db.query(
        `INSERT INTO ari_outbox_store
           (tenant_id, property_id, event_type, resource_kind, room_type_id,
            rate_plan_id, effective_from, effective_to, source_version,
            dedupe_key, payload_json, restriction_rule_id, status${v.maxRetries !== null ? ', max_retries' : ''})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING'${v.maxRetries !== null ? ',$13' : ''})
         ON CONFLICT (tenant_id, property_id, dedupe_key)
         DO NOTHING
         RETURNING *`,
        v.maxRetries !== null
          ? [v.tenantId, v.propertyId, v.eventType, v.resourceKind, v.roomTypeId, v.ratePlanId, v.effectiveFrom, v.effectiveTo, v.sourceVersion, v.dedupeKey, v.payload, restrictionRuleId, v.maxRetries]
          : [v.tenantId, v.propertyId, v.eventType, v.resourceKind, v.roomTypeId, v.ratePlanId, v.effectiveFrom, v.effectiveTo, v.sourceVersion, v.dedupeKey, v.payload, restrictionRuleId]
      );
      if (r.rows[0]) return { accepted: true, deduped: false, row: r.rows[0] };
      const existing = await db.query(
        `SELECT * FROM ari_outbox_store
          WHERE tenant_id = $1 AND property_id = $2 AND dedupe_key = $3`,
        [v.tenantId, v.propertyId, v.dedupeKey]
      );
      return { accepted: false, deduped: true, existing: existing.rows[0] || null };
    },

    /**
     * Claim due PENDING work under the bound tenant (RLS supplies the tenant
     * predicate). Due = next_retry_at absent or past, retry_count under the
     * cap. FOR UPDATE SKIP LOCKED so concurrent claimers never double-claim.
     * Sets a lease and transitions to PROCESSING. Does NOT increment
     * attempts (documented B2M-matching semantics: attempts counts finished
     * processing attempts, not claims).
     */
    async claimDue({ limit = 1, leaseOwner = null, leaseMs = 60000 } = {}) {
      const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 1;
      const r = await db.query(
        `UPDATE ari_outbox_store
            SET status = 'PROCESSING',
                lease_until = now() + ($2 * interval '1 millisecond'),
                lease_owner = $3,
                updated_at = now()
          WHERE id IN (
            SELECT id FROM ari_outbox_store
             WHERE status = 'PENDING'
               AND (next_retry_at IS NULL OR next_retry_at <= now())
               AND retry_count < max_retries
             ORDER BY created_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [safeLimit, leaseMs, leaseOwner]
      );
      return r.rows;
    },

    /** PROCESSING -> COMPLETED. Clears the lease, stamps completed_at. */
    async markCompleted(id) {
      const r = await db.query(
        `UPDATE ari_outbox_store
            SET status = 'COMPLETED', lease_until = NULL, lease_owner = NULL,
                completed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING'
        RETURNING *`,
        [id]
      );
      return r.rows[0] || null;
    },

    /**
     * PROCESSING -> PENDING with next_retry_at in the future (no RETRY_WAIT
     * status — B2M model). attempts and retry_count each increment exactly
     * once. Lease cleared.
     */
    async markRetryScheduled(id, nextRetryAt) {
      const r = await db.query(
        `UPDATE ari_outbox_store
            SET status = 'PENDING', attempts = attempts + 1,
                retry_count = retry_count + 1, next_retry_at = $2,
                lease_until = NULL, lease_owner = NULL, updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING'
        RETURNING *`,
        [id, nextRetryAt]
      );
      return r.rows[0] || null;
    },

    /**
     * PROCESSING -> DEAD_LETTER (terminal). attempts increments exactly
     * once; retry_count is preserved as-is (B2M semantics). Lease and
     * next_retry_at cleared, dead_lettered_at stamped.
     */
    async markDeadLetter(id) {
      const r = await db.query(
        `UPDATE ari_outbox_store
            SET status = 'DEAD_LETTER', attempts = attempts + 1,
                next_retry_at = NULL, lease_until = NULL, lease_owner = NULL,
                dead_lettered_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'PROCESSING'
        RETURNING *`,
        [id]
      );
      return r.rows[0] || null;
    },

    /**
     * Expired-lease recovery: PROCESSING rows whose lease has passed return
     * to PENDING so the normal claim path can pick them up when due. Only
     * rows with an actually-expired, non-NULL lease qualify; an active
     * lease is never broken. retry_count and attempts are preserved (see
     * the module header for the documented semantics). FOR UPDATE SKIP
     * LOCKED so two concurrent recoverers never fight over the same row —
     * and since this is a status flip on the SAME row, no duplicate active
     * row can ever result.
     */
    async requeueExpiredLeases({ limit = 100 } = {}) {
      const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
      const r = await db.query(
        `UPDATE ari_outbox_store
            SET status = 'PENDING', lease_until = NULL, lease_owner = NULL,
                updated_at = now()
          WHERE id IN (
            SELECT id FROM ari_outbox_store
             WHERE status = 'PROCESSING'
               AND lease_until IS NOT NULL
               AND lease_until <= now()
             ORDER BY lease_until
             LIMIT $1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [safeLimit]
      );
      return r.rows;
    },

    async get(id) {
      const r = await db.query('SELECT * FROM ari_outbox_store WHERE id = $1', [id]);
      return r.rows[0] || null;
    },

    async list(status) {
      const r = status
        ? await db.query('SELECT * FROM ari_outbox_store WHERE status = $1 ORDER BY created_at', [status])
        : await db.query('SELECT * FROM ari_outbox_store ORDER BY created_at', []);
      return r.rows;
    }
  };
}

module.exports = {
  buildAriOutboxStore,
  buildAriDedupeKey,
  buildAriRestrictionDedupeKey,
  validateEnqueueInput,
  validateRestrictionEnqueueInput,
  EVENT_TYPES,
  RESOURCE_KINDS,
  EVENT_RESOURCE,
  RESTRICTION_LEVELS,
  STATUS
};
