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
 */

const logger = require('../../config/logger');

function buildChannelQueueWorker({
  queue, processor,
  pollMs = 1000, limit = 25, enabled = false
} = {}) {
  if (!queue) throw new Error('channelQueueWorker: queue required');
  if (typeof queue.dequeuePendingAcrossTenants !== 'function') {
    throw new Error('channelQueueWorker: queue.dequeuePendingAcrossTenants(...) required');
  }
  if (typeof queue.markCompleted !== 'function') {
    throw new Error('channelQueueWorker: queue.markCompleted(tenantId, id) required');
  }
  if (typeof queue.markFailed !== 'function') {
    throw new Error('channelQueueWorker: queue.markFailed(tenantId, id) required');
  }
  if (!processor) throw new Error('channelQueueWorker: processor required');

  let _timer = null;
  // Non-overlapping tick guard: a slow tick (real DB round trips, one
  // transaction per discovered tenant) must not run concurrently with the
  // next scheduled tick — that would risk two in-flight batches processing
  // under interleaved async execution. A second concurrent tick() call is a
  // deliberate no-op ({ skipped: true }), never a queued/duplicate run.
  let _ticking = false;
  const stats = { processed: 0, completed: 0, failures: 0 };

  async function tick() {
    if (_ticking) return { skipped: true };
    _ticking = true;
    try {
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
          await queue.markFailed(job.tenant_id, job.id);
          stats.failures += 1;
          results.push({ id: job.id, status: 'FAILED' });
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
    return { processed: stats.processed, completed: stats.completed, failed: stats.failures };
  }

  return { tick, start, stop, isRunning, metrics, stats, enabled };
}

module.exports = { buildChannelQueueWorker };
