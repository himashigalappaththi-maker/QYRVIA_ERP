'use strict';

/**
 * confirmationQueue (Phase 27.3) - in-memory outbound confirmation queue.
 *
 * Guarantees (mirrors the channel-manager queue contract, reusing its RetryPolicy):
 *   - Idempotency: an item whose `key` was already accepted is dropped
 *     ({deduped:true}); a duplicate booking event delivers at most once.
 *   - Retry with exponential backoff on transient transport failure (RetryPolicy).
 *   - Dead-letter: an item that fails every attempt is moved to `deadLetter`; the
 *     drain of the remaining items is never aborted (partial-failure isolation).
 *
 * No persistence and no external calls of its own - it only invokes the injected
 * transport. clock + sleep are injectable so tests run instantly + deterministically.
 */

const { RetryPolicy } = require('../channel-manager/core/sync/RetryPolicy');

function buildConfirmationQueue({ transport, retryPolicy, clock, sleep } = {}) {
  if (!transport || typeof transport.send !== 'function') throw new Error('confirmationQueue: transport.send required');
  const retry = retryPolicy || new RetryPolicy({ maxAttempts: 4, baseMs: 50, factor: 2, maxMs: 5000 });
  const _clock = clock || (() => Date.now());
  const _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const pending = [];
  const seen = new Set();
  const sent = [];
  const deadLetter = [];

  /** Accept an item: { key, to, message, meta }. Duplicate keys are dropped. */
  function enqueue(item) {
    if (!item || !item.to) throw new Error('enqueue: item.to required');
    if (item.key) {
      if (seen.has(item.key)) return { accepted: false, deduped: true, key: item.key };
      seen.add(item.key);
    }
    pending.push(item);
    return { accepted: true, key: item.key || null };
  }

  function size() { return pending.length; }
  function stats() { return { pending: pending.length, sent: sent.length, dead: deadLetter.length }; }

  /**
   * Re-queue dead-lettered items for another delivery attempt (operational replay).
   * Bypasses idempotency dedup on purpose - these keys were already accepted, the
   * delivery just failed. Returns the number of items moved back to pending.
   */
  function replayDeadLetter() {
    const n = deadLetter.length;
    while (deadLetter.length) {
      const rec = deadLetter.shift();
      pending.push({ key: rec.key, to: rec.to, message: rec.message, meta: rec.meta });
    }
    return n;
  }

  /** Drain all pending items in FIFO order. Failures are isolated + dead-lettered. */
  async function drain() {
    const results = [];
    while (pending.length > 0) {
      const item = pending.shift();
      let attempts = 0, lastErr = null, ok = false, value;
      while (true) {
        attempts += 1;
        try { value = await transport.send(item.to, item.message, item.meta); ok = true; break; }
        catch (err) {
          lastErr = err;
          if (!retry.shouldRetry(attempts)) break;
          await _sleep(retry.nextDelay(attempts));
        }
      }
      const rec = { key: item.key || null, to: item.to, message: item.message, meta: item.meta || null, attempts, at: _clock() };
      if (ok) { rec.status = 'sent'; rec.value = value; sent.push(rec); }
      else { rec.status = 'dead'; rec.error = String((lastErr && lastErr.message) || lastErr); deadLetter.push(rec); }
      results.push(rec);
    }
    return results;
  }

  return { enqueue, drain, size, stats, replayDeadLetter, sent, deadLetter };
}

module.exports = { buildConfirmationQueue };
