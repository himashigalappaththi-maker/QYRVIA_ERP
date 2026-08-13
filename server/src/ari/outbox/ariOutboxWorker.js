'use strict';

/**
 * Phase 66A-B2N-D — the ARI outbox drain worker.
 *
 * B2N-A..C2 built the RECORD side of the ARI outbox: an authoritative ARI
 * mutation and its outbox row commit in ONE tenant-bound transaction. Nothing
 * ever drained that table, so every event sat PENDING forever. This worker is
 * the drain loop — and NOTHING MORE.
 *
 * TRANSPORT-FREE BY CONSTRUCTION
 * ──────────────────────────────
 * There is no provider, adapter, HTTP client or channel-manager import here,
 * and there must never be one. The dispatcher is INJECTED. That keeps
 * server/src/ari/ at zero channel-manager coupling (the property migration
 * 0087 and ariOutboxStore.js both assert about themselves) and means this file
 * cannot, by construction, deliver anything to a real OTA. P0-12 therefore
 * stays PARTIAL after this phase: sub-gap 4b (nothing drains the outbox) is
 * addressed; sub-gap 4a (no ARI→channel bridge) and the transport itself are
 * deliberately still open.
 *
 * WHY THE GATES ARE CHECKED BEFORE TENANT RESOLUTION
 * ─────────────────────────────────────────────────
 * Resolving tenants means calling a BYPASSRLS SECURITY DEFINER function. That
 * is the single most privileged thing this worker does, so it happens only
 * after every gate has said yes. A tick that is gated off performs no resolver
 * call, no claim and no transition — it increments ticksSkipped and returns.
 *
 * DELIVERY SEMANTICS: AT-LEAST-ONCE
 * ─────────────────────────────────
 * A worker may complete its dispatcher call and then crash before recording the
 * outcome; the lease expires and the row is processed again. Any future real
 * transport MUST therefore be idempotent per (dedupe_key, source_version) —
 * the same requirement ariOutboxStore.js records in its own header. This
 * worker claims NO ordering guarantee: rows are claimed by created_at within a
 * tenant, but concurrent workers and per-row retries mean a later
 * source_version can be delivered before an earlier one. Nothing here collapses
 * or reorders events.
 */

const { DEFAULT_LIMIT: RESOLVER_DEFAULT_LIMIT } = require('./ariOutboxTenantResolver');

/**
 * Deterministic bounded exponential backoff, derived ONLY from the row's
 * existing retry_count:
 *
 *   delayMs = min(RETRY_BASE_MS * 2^retry_count, RETRY_MAX_MS)
 *
 * retry_count = 0 -> 30s, 1 -> 60s, 2 -> 2m, 3 -> 4m, ... capped at 1h.
 * No randomness in production (a test may inject a clock, never a jitter
 * source), so a given row's schedule is fully reproducible. The worker computes
 * only the TIMESTAMP; attempts and retry_count remain the exclusive business of
 * ariOutboxStore.markRetryScheduled, and max_retries is never mutated.
 */
const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 3600000;

function computeRetryDelayMs(retryCount) {
  const n = Number.isInteger(retryCount) && retryCount > 0 ? retryCount : 0;
  // Cap the exponent before shifting so a corrupt retry_count cannot overflow
  // into a negative or non-finite delay.
  const capped = Math.min(n, 32);
  const raw = RETRY_BASE_MS * Math.pow(2, capped);
  return Math.min(raw, RETRY_MAX_MS);
}

function fail(message) {
  return new Error('ariOutboxWorker: ' + message);
}

/** An error is retryable unless it explicitly says otherwise. */
function isRetryable(err) {
  if (err && err.retryable === false) return false;
  if (err && err.nonRetryable === true) return false;
  return true;
}

function emptyCounters() {
  return {
    tenantsResolved: 0,
    tenantsProcessed: 0,
    leasesRecovered: 0,
    rowsClaimed: 0,
    rowsCompleted: 0,
    rowsRetried: 0,
    rowsDeadLettered: 0,
    rowsFailed: 0,
    ticksSkipped: 0
  };
}

/**
 * The immutable envelope handed to the dispatcher. Built by copying named
 * fields off the persisted row — never by passing the row itself — so a
 * dispatcher cannot mutate worker state, and so widening the outbox schema
 * cannot silently widen what leaves this boundary.
 */
function buildDeliveryEnvelope(row) {
  return Object.freeze({
    id:                row.id,
    tenantId:          row.tenant_id,
    propertyId:        row.property_id,
    eventType:         row.event_type,
    resourceKind:      row.resource_kind,
    roomTypeId:        row.room_type_id,
    ratePlanId:        row.rate_plan_id,
    restrictionRuleId: row.restriction_rule_id,
    effectiveFrom:     row.effective_from,
    effectiveTo:       row.effective_to,
    dedupeKey:         row.dedupe_key,
    sourceVersion:     row.source_version,
    payload:           row.payload_json
  });
}

/**
 * @param {object} deps
 * @param {{resolveDueTenants: Function}} deps.tenantResolver
 * @param {object} deps.outbox   tenant-bound wrappers (tenantAriOutbox.js):
 *        claimDueForTenant, markCompletedForTenant, markRetryScheduledForTenant,
 *        markDeadLetterForTenant, requeueExpiredLeasesForTenant.
 * @param {{query: Function}} deps.pool  passed straight through to those
 *        wrappers, which open the tenant-bound transaction. This worker never
 *        queries the pool itself.
 * @param {{dispatch: Function, isReady?: Function}} deps.dispatcher
 * @param {Function} [deps.clock]   () => Date, injectable for tests.
 * @param {object}   [deps.logger]
 * @param {string}   deps.workerId  stable for one instance, distinct between
 *        instances — it becomes the outbox lease_owner.
 * @param {object}   [deps.config]
 */
function buildAriOutboxWorker({
  tenantResolver,
  outbox,
  pool,
  dispatcher,
  clock,
  logger,
  workerId,
  config
} = {}) {
  // Fail closed at construction. A worker missing a dependency must not boot
  // into a state where it silently drains nothing (or worse, drains without a
  // tenant-bound wrapper).
  if (!tenantResolver || typeof tenantResolver.resolveDueTenants !== 'function') {
    throw fail('tenantResolver.resolveDueTenants required');
  }
  if (!outbox
      || typeof outbox.claimDueForTenant !== 'function'
      || typeof outbox.markCompletedForTenant !== 'function'
      || typeof outbox.markRetryScheduledForTenant !== 'function'
      || typeof outbox.markDeadLetterForTenant !== 'function'
      || typeof outbox.requeueExpiredLeasesForTenant !== 'function') {
    throw fail('tenant-bound outbox wrappers required');
  }
  if (!pool || typeof pool.query !== 'function') throw fail('pool.query required');
  if (!dispatcher || typeof dispatcher.dispatch !== 'function') throw fail('dispatcher.dispatch required');
  if (typeof workerId !== 'string' || workerId.length === 0) throw fail('workerId required');

  const cfg = config || {};
  const tenantLimit = Number.isInteger(cfg.tenantLimit) ? cfg.tenantLimit : RESOLVER_DEFAULT_LIMIT;
  const batchLimit = Number.isInteger(cfg.batchLimit) ? cfg.batchLimit : 25;
  const leaseMs = Number.isInteger(cfg.leaseMs) ? cfg.leaseMs : 60000;
  const recoverLimit = Number.isInteger(cfg.recoverLimit) ? cfg.recoverLimit : 100;
  const isEnabled = typeof cfg.isEnabled === 'function' ? cfg.isEnabled : () => false;
  const isDispatchEnabled = typeof cfg.isDispatchEnabled === 'function' ? cfg.isDispatchEnabled : () => false;

  const now = typeof clock === 'function' ? clock : () => new Date();
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };

  /** Both gates plus dispatcher readiness. Any false => the tick is skipped. */
  function readyToWork() {
    if (isEnabled() !== true) return false;
    if (isDispatchEnabled() !== true) return false;
    // A dispatcher with no isReady() is treated as NOT ready. There is no
    // default success dispatcher in this phase, and a missing readiness signal
    // must never be read as consent to claim rows.
    if (typeof dispatcher.isReady !== 'function') return false;
    return dispatcher.isReady() === true;
  }

  /** Process exactly one claimed row. Never throws — the caller keeps going. */
  async function processRow(tenantId, row, counters) {
    let dispatchErr = null;
    try {
      await dispatcher.dispatch(buildDeliveryEnvelope(row));
    } catch (e) {
      dispatchErr = e || fail('dispatcher rejected without an error');
    }

    try {
      if (!dispatchErr) {
        await outbox.markCompletedForTenant({ pool, tenantId, id: row.id });
        counters.rowsCompleted += 1;
        return;
      }

      // retry_count is what the row already carries; markRetryScheduled will
      // increment it. If the incremented value would reach max_retries the row
      // could never be claimed again (claimDue requires retry_count <
      // max_retries), so it would sit PENDING forever. Dead-letter it now
      // instead — exactly once, and never via the retry path as well.
      const retryCount = Number.isInteger(row.retry_count) ? row.retry_count : 0;
      const maxRetries = Number.isInteger(row.max_retries) ? row.max_retries : 0;
      const exhausted = retryCount + 1 >= maxRetries;

      if (!isRetryable(dispatchErr) || exhausted) {
        await outbox.markDeadLetterForTenant({ pool, tenantId, id: row.id });
        counters.rowsDeadLettered += 1;
        return;
      }

      const nextRetryAt = new Date(now().getTime() + computeRetryDelayMs(retryCount));
      await outbox.markRetryScheduledForTenant({ pool, tenantId, id: row.id, nextRetryAt });
      counters.rowsRetried += 1;
    } catch (transitionErr) {
      // The transition itself failed (lost lease, connection drop). The row
      // stays PROCESSING and its lease expiry will recover it on a later tick;
      // that is the designed recovery path, so this is counted, not rethrown.
      counters.rowsFailed += 1;
      log.warn({ err: transitionErr, tenantId }, '[ari-outbox-worker] transition failed; lease expiry will recover the row');
    }
  }

  /** Drain one tenant. Never throws — one bad tenant must not stop the tick. */
  async function processTenant(tenantId, counters) {
    try {
      const recovered = await outbox.requeueExpiredLeasesForTenant({ pool, tenantId, limit: recoverLimit });
      counters.leasesRecovered += Array.isArray(recovered) ? recovered.length : 0;

      const claimed = await outbox.claimDueForTenant({
        pool, tenantId, limit: batchLimit, leaseOwner: workerId, leaseMs
      });
      const rows = Array.isArray(claimed) ? claimed : [];
      counters.rowsClaimed += rows.length;

      for (const row of rows) {
        await processRow(tenantId, row, counters);
      }

      counters.tenantsProcessed += 1;
    } catch (e) {
      counters.rowsFailed += 1;
      log.warn({ err: e, tenantId }, '[ari-outbox-worker] tenant drain failed');
    }
  }

  return {
    workerId,
    computeRetryDelayMs,

    /**
     * One drain pass. Returns counters ONLY — never a row, a payload, a
     * dedupe key or a dispatcher response.
     */
    async tick() {
      const counters = emptyCounters();

      if (!readyToWork()) {
        counters.ticksSkipped = 1;
        return counters;
      }

      let tenants;
      try {
        tenants = await tenantResolver.resolveDueTenants({ limit: tenantLimit });
      } catch (e) {
        // A resolver failure is not a per-row failure: nothing was claimed.
        counters.ticksSkipped = 1;
        log.warn({ err: e }, '[ari-outbox-worker] tenant resolution failed');
        return counters;
      }

      counters.tenantsResolved = tenants.length;
      for (const tenantId of tenants) {
        await processTenant(tenantId, counters);
      }
      return counters;
    }
  };
}

module.exports = {
  buildAriOutboxWorker,
  computeRetryDelayMs,
  buildDeliveryEnvelope,
  isRetryable,
  RETRY_BASE_MS,
  RETRY_MAX_MS
};
