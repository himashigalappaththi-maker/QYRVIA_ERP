'use strict';

/**
 * Channel queue worker (Phase 24 B6) - polls a lease queue, processes jobs via a
 * MOCK processor (no OTA), and routes outcomes:
 *   success           -> COMPLETED
 *   failure (retries) -> RETRY (backoff via workerRetryPolicy)
 *   retries exhausted -> DEAD_LETTER (recorded in dead_letter_store)
 *
 * Crash-safe: each tick first recovers expired leases. Worker-safe: lease owner
 * gates transitions. Default OFF: start() is a no-op unless `enabled`.
 */

const { buildWorkerRetryPolicy } = require('./workerRetryPolicy');
const logger = require('../../config/logger');

function buildChannelQueueWorker({
  queue, processor, deadLetterStore, retryPolicy,
  clock = () => Date.now(), owner = 'worker-1', leaseMs = 30000, pollMs = 1000, enabled = false
} = {}) {
  if (!queue) throw new Error('channelQueueWorker: queue required');
  if (!processor) throw new Error('channelQueueWorker: processor required');
  const rp = retryPolicy || buildWorkerRetryPolicy();
  let _timer = null;
  const stats = { processed: 0, completed: 0, failures: 0, retries: 0, deadLettered: 0 };

  async function tick() {
    const now = clock();
    queue.recoverExpired(now);                       // crash recovery first
    const job = queue.leaseNext(owner, leaseMs, now);
    if (!job) return { idle: true };
    stats.processed += 1;

    let result;
    try { result = await processor.process(job); }
    catch (err) { result = { ok: false, error: String((err && err.message) || err) }; }

    if (result && result.ok) {
      queue.markCompleted(job.id, owner); stats.completed += 1;
      return { id: job.id, status: 'COMPLETED' };
    }

    stats.failures += 1;
    const reason = (result && result.error) || 'failed';
    const decision = rp.next(job.retry_count);
    if (decision.retry) {
      queue.markFailedRetry(job.id, owner, now + decision.delayMs); stats.retries += 1;
      return { id: job.id, status: 'RETRY', retry_count: job.retry_count + 1, next_retry_at: now + decision.delayMs };
    }

    // Retries exhausted -> dead-letter.
    if (deadLetterStore && typeof deadLetterStore.insert === 'function') {
      deadLetterStore.insert({
        tenant_id: job.tenant_id || 'unknown', reservation_id: job.reservation_id,
        action: job.action, channel: job.channel, last_error: reason,
        payload: job.payload, attempts: job.retry_count + 1
      });
    }
    queue.markDeadLetter(job.id, owner, reason); stats.deadLettered += 1;
    return { id: job.id, status: 'DEAD_LETTER' };
  }

  // Process until the queue has nothing immediately eligible (bounded).
  async function drain(maxCycles = 1000) {
    let n = 0, r;
    do { r = await tick(); n += 1; } while (!r.idle && n < maxCycles);
    return { cycles: n };
  }

  function start() {
    if (!enabled) { logger.info('[channelWorker] disabled (CHANNEL_WORKER_ENABLED=false)'); return false; }
    if (_timer) return true;
    _timer = setInterval(() => { tick().catch((err) => logger.error({ err }, '[channelWorker] tick error')); }, pollMs);
    if (_timer.unref) _timer.unref();
    logger.info({ pollMs, leaseMs, owner }, '[channelWorker] started');
    return true;
  }
  function stop() { if (_timer) { clearInterval(_timer); _timer = null; } return true; }
  function isRunning() { return _timer != null; }

  function metrics() {
    const c = queue.counts();
    return {
      queueDepth: c.PENDING,
      processing: c.PROCESSING,
      completed:  c.COMPLETED,
      failed:     stats.failures,
      deadLetter: c.DEAD_LETTER,
      retries:    stats.retries,
      processed:  stats.processed
    };
  }

  return { tick, drain, start, stop, isRunning, metrics, stats, enabled };
}

module.exports = { buildChannelQueueWorker };
