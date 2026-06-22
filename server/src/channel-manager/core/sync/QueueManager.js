'use strict';

/**
 * QueueManager - the queue-based processing abstraction the brief mandates.
 *
 * Guarantees:
 *   - Idempotency: a job whose `idempotencyKey` has already been accepted is
 *     dropped (returns {deduped:true}); the underlying op runs at most once.
 *   - Retry with exponential backoff (delegated to RetryPolicy).
 *   - Partial failure isolation: one job failing (even after retries) never
 *     aborts the drain of the others; failures are collected + dead-lettered.
 *   - Per-OTA rate limiting: an optional minimum interval per channel.
 *
 * Clock + sleep are injectable so tests run instantly and deterministically
 * (no real wall-clock waits).
 */

const { RetryPolicy } = require('./RetryPolicy');

class QueueManager {
  constructor({ retryPolicy, clock, sleep, rateLimits } = {}) {
    this._retry = retryPolicy || new RetryPolicy();
    this._clock = clock || (() => Date.now());
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._rateLimits = rateLimits || {};   // { [channel]: minIntervalMs }
    this._queue = [];
    this._seen = new Set();                 // accepted idempotency keys
    this._lastStart = new Map();            // channel -> last start time
    this.deadLetter = [];
  }

  /** Accept a job. Duplicate idempotency keys are dropped. */
  enqueue(job) {
    if (!job || typeof job.run !== 'function') throw new Error('enqueue: job.run required');
    const key = job.idempotencyKey;
    if (key) {
      if (this._seen.has(key)) return { accepted: false, deduped: true, idempotencyKey: key };
      this._seen.add(key);
    }
    this._queue.push(job);
    return { accepted: true, idempotencyKey: key || null };
  }

  size() { return this._queue.length; }

  async _rateLimit(channel) {
    const minInterval = this._rateLimits[channel];
    if (!minInterval) return;
    const last = this._lastStart.get(channel) || 0;
    const wait = last + minInterval - this._clock();
    if (wait > 0) await this._sleep(wait);
    this._lastStart.set(channel, this._clock());
  }

  /**
   * Drain the queue. Returns a results array; failures are isolated and also
   * pushed to `deadLetter`. Jobs are processed in FIFO order.
   */
  async process() {
    const results = [];
    while (this._queue.length > 0) {
      const job = this._queue.shift();
      await this._rateLimit(job.channel);

      let attempts = 0;
      let lastErr = null;
      let ok = false;
      let value;
      while (true) {
        attempts += 1;
        try {
          value = await job.run();
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          if (!this._retry.shouldRetry(attempts)) break;
          await this._sleep(this._retry.nextDelay(attempts));
        }
      }

      if (ok) {
        results.push({ ok: true, idempotencyKey: job.idempotencyKey || null, channel: job.channel, attempts, value });
      } else {
        const rec = { ok: false, idempotencyKey: job.idempotencyKey || null, channel: job.channel,
          attempts, error: String(lastErr && lastErr.message || lastErr), job };
        this.deadLetter.push(rec);
        results.push(rec);    // isolated: loop continues to next job
      }
    }
    return results;
  }
}

module.exports = { QueueManager };
