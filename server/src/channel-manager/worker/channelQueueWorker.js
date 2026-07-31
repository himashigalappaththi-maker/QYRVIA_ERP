'use strict';

/**
 * Channel queue worker (Phase 24 B6; repaired Phase 66A-B2J).
 *
 * Polls the tenant-bound persistence queue, processes claimed jobs via a
 * MOCK processor (no OTA), and routes outcomes:
 *   success -> COMPLETED (persistent, per tenant)
 *   failure -> FAILED    (persistent, per tenant — terminal; see below)
 *
 * PHASE 66A-B2J REPAIR, DISCLOSED
 * ────────────────────────────────
 * This worker used to be written against a lease-queue contract
 * (recoverExpired/leaseNext/markFailedRetry/markDeadLetter/counts,
 * ./leaseQueue.js) that channelPersistence.queue — the object actually
 * wired at boot (built from ./persistence/dbStores.js or
 * ./persistence/memoryStores.js) — never implemented. Every tick() call
 * threw a TypeError, swallowed by tick().catch(...) in start(), so the
 * worker processed zero jobs in production regardless of persistence mode.
 * Confirmed by direct inspection, not assumed: grepping the whole
 * repository for `.dequeue(` found dequeue()'s only callers were test
 * files.
 *
 * `queue` is now a three-method contract this worker actually depends on:
 *
 *   queue.dequeuePendingAcrossTenants({ limit }) -> Promise<Array<row>>
 *     One tenant-scoped discovery+claim pass. In db-persistence mode this
 *     is server/src/channel-manager/persistence/dbStores.js's
 *     dequeuePendingAcrossTenants({pool, limit}), which discovers due
 *     tenants via the verified SECURITY DEFINER resolver
 *     worker_resolvers.pending_channel_tenants and claims at most one row
 *     per tenant inside its own tenant-bound transaction (Phase 66A-B2I).
 *     Every returned row carries its own tenant_id.
 *
 *   queue.markCompleted(tenantId, id) -> Promise<row|null>
 *   queue.markFailed(tenantId, id)    -> Promise<row|null>
 *     Persist the outcome for one claimed row, scoped to its own tenant
 *     (dbStores.js's markQueueCompletedForTenant / markQueueFailedForTenant
 *     in db-persistence mode — each opens its own tenant-bound unit of work
 *     and calls the original, unchanged markCompleted(id)/markFailed(id)).
 *
 * lease/retry/dead-letter removal, disclosed: the PostgreSQL persistence
 * layer has no lease_owner/lease_expires_at concept, no backoff-scheduling
 * write path (markFailed(id) only ever sets a TERMINAL FAILED status and
 * increments `attempts` — it never resets a row to PENDING with a computed
 * next_retry_at), and channel_sync_queue_store's own status CHECK
 * constraint has no DEAD_LETTER value at all (only PENDING/PROCESSING/
 * COMPLETED/FAILED). There is therefore no compatible persistence-layer
 * equivalent for recoverExpired, leaseNext-with-lease-tracking,
 * markFailedRetry, markDeadLetter, or status-count metrics — inventing one
 * here would mean designing new retry/dead-letter semantics, which this
 * repair phase is explicitly not authorized to do. Every processor failure
 * is therefore handled as the one persistence-supported outcome: a single,
 * terminal FAILED transition via markFailed(). This is a disclosed
 * behavior change from the pre-repair code's (never-reached, since it
 * always threw first) intended retry/dead-letter routing — not a
 * preservation of it. Automatic retry scheduling and dead-lettering for
 * this queue remain a later, separately-scoped requirement.
 *
 * leaseQueue.js and workerRetryPolicy.js are unmodified and still usable —
 * this file simply no longer depends on either. deadLetterStore is no
 * longer a dependency of this worker for the same reason: with no
 * exhaustion/backoff decision being made here, there is no principled
 * moment left in this file to decide a row should be dead-lettered.
 *
 * Still mock-only: buildMockProcessor() is the only processor this file
 * ever calls; nothing here imports or references realProcessor.js,
 * CHANNEL_WORKER_REAL, fetch/axios/http(s).request, or channelRegistry.
 * Default OFF: start() is a no-op unless `enabled`.
 *
 * PHASE 66A-B2K — FAIL-CLOSED DISPATCH KILL SWITCH
 * ──────────────────────────────────────────────────
 * `isDispatchEnabled` is a required, injected guard — sync or async —
 * re-evaluated at the START of every tick, after the overlap guard but
 * BEFORE queue.dequeuePendingAcrossTenants is ever called. Only an EXACT
 * `true` return value permits a tick to claim anything; any other value
 * (false, undefined, a truthy non-boolean, a thrown error, a rejected
 * promise) fails closed: zero rows are claimed, zero rows are modified,
 * processor.process is never called. A guard failure is swallowed here —
 * its message/stack is never surfaced — so a broken guard cannot leak
 * environment or queue detail through a log line; it can only ever narrow
 * behaviour toward "claim nothing", never widen it toward "claim
 * everything". This is independent of, and evaluated in addition to,
 * `enabled` (which only gates whether the polling loop starts at all).
 *
 * PHASE 66A-B2L — REGISTRY-DENIED RESULT DISTINCTION
 * ──────────────────────────────────────────────────
 * A processor result of `{ ok: false, skipped: true, ... }` (see
 * realProcessor.js's per-channel registry authorization) is routed through
 * the same retryable-failure path as any other `{ ok: false }` result — see
 * the B2M note below — and additionally counted in its own
 * `stats.registryDenied` counter, purely for observability, so a
 * registry-driven denial is distinguishable from a genuine processor/
 * transport failure without changing which queue transition it uses.
 *
 * PHASE 66A-B2M — DURABLE RETRY, CAPPED BACKOFF AND DEAD-LETTER HANDLING
 * ────────────────────────────────────────────────────────────────────
 * markFailed() is no longer this worker's normal failure transition — see
 * migration 0086 and dbStores.js's new markRetryScheduled/markDeadLetter for
 * the persistence side. `queue` is now a FOUR-method contract:
 *
 *   queue.dequeuePendingAcrossTenants({ limit }) -> Promise<Array<row>>  (unchanged)
 *   queue.markCompleted(tenantId, id)            -> Promise<row|null>   (unchanged)
 *   queue.markRetryScheduled(tenantId, id, nextRetryAt) -> Promise<row|null>
 *   queue.markDeadLetter(tenantId, id)                  -> Promise<row|null>
 *
 * FAILURE CLASSIFICATION — stable result codes only, never raw error text.
 * `NON_RETRYABLE_CODES` is an explicit whitelist of codes that can never
 * succeed on retry (malformed job / unresolvable channel): unknown_action,
 * channel_required, tenant_required, no_provider_for_channel. Every other
 * `result.error` value — including channel_disabled (registry denial),
 * transport_disabled, qtcn_dispatch_error, transport_error, mock_failure,
 * and any uncategorized thrown-error message — defaults to retryable. This
 * is a deliberate, disclosed default: an unrecognized code is assumed
 * transient rather than assumed permanent, because the bounded retry limit
 * below already protects against a genuinely permanent failure looping
 * forever, whereas assuming "permanent" for an unrecognized code would risk
 * prematurely dead-lettering a merely-unfamiliar transient error.
 *
 * RETRY-COUNT / MAX-RETRIES SEMANTICS — `job.retry_count` is the number of
 * attempts (initial + retries) that have already failed; `job.max_retries`
 * (DEFAULT 4, migration 0064) is the ceiling on total delivery attempts —
 * this is 0064's OWN stated semantic ("sets an explicit per-job ceiling on
 * how many delivery attempts the channel worker will make"), not "retries
 * after the initial attempt". This distinction is forced by a fact
 * discovered during this phase, not a stylistic choice: the SECURITY
 * DEFINER resolver worker_resolvers.pending_channel_tenants (superuser-owned,
 * unmodifiable this phase) hardcodes `retry_count < max_retries` as its own
 * due-ness filter. Using workerRetryPolicy.js's OWN existing `next(n)`
 * contract (n < backoff.length -> retry) against `job.retry_count` before
 * it is incremented keeps every row reachable right up to its last allowed
 * attempt and dead-letters deterministically the moment scheduling another
 * retry would push retry_count to >= max_retries — never leaving a row
 * silently stuck at a retry_count the resolver would treat as exhausted.
 *
 * RETRY-WAIT STATE — see migration 0086's header: a scheduled retry returns
 * the row to status='PENDING' with next_retry_at set to a future,
 * clock-computed timestamp (backoff.js's `retryPolicy`, an injected clock —
 * never a real sleep). No RETRY_WAIT status value exists; the existing
 * resolver/dequeue due-time predicates already exclude a future-dated
 * PENDING row until it is due, exactly as they were built to.
 */

const logger = require('../../config/logger');
const { buildWorkerRetryPolicy } = require('./workerRetryPolicy');

// Explicit whitelist: only these codes are treated as permanently
// non-retryable. Everything else defaults to retryable (see header note).
const NON_RETRYABLE_CODES = new Set([
  'unknown_action',
  'channel_required',
  'tenant_required',
  'no_provider_for_channel'
]);

function buildChannelQueueWorker({
  queue, processor, isDispatchEnabled,
  retryPolicy = buildWorkerRetryPolicy(),
  clock = () => Date.now(),
  pollMs = 1000, limit = 25, enabled = false
} = {}) {
  if (!queue) throw new Error('channelQueueWorker: queue required');
  if (typeof queue.dequeuePendingAcrossTenants !== 'function') {
    throw new Error('channelQueueWorker: queue.dequeuePendingAcrossTenants(...) required');
  }
  if (typeof queue.markCompleted !== 'function') {
    throw new Error('channelQueueWorker: queue.markCompleted(tenantId, id) required');
  }
  if (typeof queue.markRetryScheduled !== 'function') {
    throw new Error('channelQueueWorker: queue.markRetryScheduled(tenantId, id, nextRetryAt) required');
  }
  if (typeof queue.markDeadLetter !== 'function') {
    throw new Error('channelQueueWorker: queue.markDeadLetter(tenantId, id) required');
  }
  if (!processor) throw new Error('channelQueueWorker: processor required');
  if (typeof isDispatchEnabled !== 'function') {
    throw new Error('channelQueueWorker: isDispatchEnabled() required');
  }

  let _timer = null;
  // Non-overlapping tick guard: a slow tick (real DB round trips, one
  // transaction per discovered tenant) must not run concurrently with the
  // next scheduled tick — that would risk two in-flight batches processing
  // under interleaved async execution. A second concurrent tick() call is a
  // deliberate no-op ({ skipped: true }), never a queued/duplicate run.
  let _ticking = false;
  const stats = {
    processed: 0, completed: 0, retried: 0, deadLettered: 0,
    disabledTicks: 0, registryDenied: 0
  };

  async function tick() {
    if (_ticking) return { skipped: true };
    _ticking = true;
    try {
      // Re-evaluated every tick — never cached across calls, never decided
      // once at construction time. Any outcome other than the exact boolean
      // `true` fails closed: no dequeue, no claim, no row modified.
      let dispatchOk = false;
      let guardFailed = false;
      try {
        dispatchOk = await isDispatchEnabled();
      } catch (_err) {
        guardFailed = true;
        dispatchOk = false;
      }
      if (dispatchOk !== true) {
        stats.disabledTicks += 1;
        return { disabled: true, reason: guardFailed ? 'dispatch_guard_error' : 'dispatch_disabled', results: [] };
      }

      const claimed = await queue.dequeuePendingAcrossTenants({ limit });
      if (!claimed || !claimed.length) return { idle: true, results: [] };

      const results = [];
      for (const job of claimed) {
        stats.processed += 1;

        let result;
        try { result = await processor.process(job); }
        catch (err) { result = { ok: false, error: String((err && err.message) || err) }; }

        if (result && result.ok) {
          await queue.markCompleted(job.tenant_id, job.id);
          stats.completed += 1;
          results.push({ id: job.id, status: 'COMPLETED' });
        } else {
          const wasRegistryDenied = !!(result && result.skipped === true);
          if (wasRegistryDenied) stats.registryDenied += 1;

          const code = result && result.error;
          const isRetryableCode = !NON_RETRYABLE_CODES.has(code);
          // Authoritative retry/dead-letter decision: job.max_retries (the
          // per-row DB value the resolver's own `retry_count < max_retries`
          // filter enforces) — NOT retryPolicy's own internal backoff.length
          // cutoff. Scheduling another retry is only safe if the resulting
          // retry_count would still satisfy that filter; otherwise the row
          // would become permanently unreachable (never explicitly
          // dead-lettered) rather than terminally stopped. retryPolicy is
          // consulted only for the backoff delay magnitude, with its own
          // index capped to its backoff array's bounds so a max_retries
          // configured larger than the policy's own schedule length can
          // never read past the array (reuses the longest configured delay
          // instead of producing a null/undefined delayMs).
          const budgetRemains = (job.retry_count + 1) < job.max_retries;
          const shouldRetry = isRetryableCode && budgetRemains;

          if (shouldRetry) {
            const cappedRetryCount = Array.isArray(retryPolicy.backoff)
              ? Math.min(job.retry_count, retryPolicy.backoff.length - 1)
              : job.retry_count;
            const decision = retryPolicy.next(cappedRetryCount);
            const nextRetryAt = new Date(clock() + decision.delayMs);
            await queue.markRetryScheduled(job.tenant_id, job.id, nextRetryAt);
            stats.retried += 1;
            const entry = { id: job.id, status: 'PENDING', retryScheduled: true };
            if (wasRegistryDenied) entry.skipped = true;
            results.push(entry);
          } else {
            await queue.markDeadLetter(job.tenant_id, job.id);
            stats.deadLettered += 1;
            results.push({ id: job.id, status: 'DEAD_LETTER' });
          }
        }
      }
      return { idle: false, results };
    } finally {
      _ticking = false;
    }
  }

  function start() {
    if (!enabled) { logger.info('[channelWorker] disabled (CHANNEL_WORKER_ENABLED=false)'); return false; }
    if (_timer) return true;
    _timer = setInterval(() => {
      tick().catch((err) => logger.error({ err }, '[channelWorker] tick error'));
    }, pollMs);
    if (_timer.unref) _timer.unref();
    logger.info({ pollMs, limit }, '[channelWorker] started');
    return true;
  }
  function stop() { if (_timer) { clearInterval(_timer); _timer = null; } return true; }
  function isRunning() { return _timer != null; }

  /**
   * Session counters only — processed/completed/failures observed by THIS
   * worker instance since it was built. Unlike the pre-repair version, this
   * no longer reports live queue-depth-by-status counts: that would require
   * either a per-tenant loop (the same discovery cost as a real tick) or an
   * unscoped cross-tenant count query — exactly the kind of global scan this
   * whole track exists to eliminate. Disclosed as a narrowed metrics surface
   * rather than simulated.
   */
  function metrics() {
    return {
      processed: stats.processed, completed: stats.completed,
      retried: stats.retried, deadLettered: stats.deadLettered,
      disabledTicks: stats.disabledTicks, registryDenied: stats.registryDenied
    };
  }

  return { tick, start, stop, isRunning, metrics, stats, enabled };
}

module.exports = { buildChannelQueueWorker };
