'use strict';

/**
 * RetryPolicy - exponential backoff with cap and optional jitter.
 *
 *   const rp = new RetryPolicy({ maxAttempts: 5, baseMs: 50, factor: 2, maxMs: 30000 });
 *   rp.shouldRetry(attemptsMade)  // attemptsMade is 1-based count already tried
 *   rp.nextDelay(attemptsMade)    // ms to wait before the next attempt
 */

class RetryPolicy {
  constructor({ maxAttempts = 5, baseMs = 50, factor = 2, maxMs = 30000, jitter = false } = {}) {
    this.maxAttempts = maxAttempts;
    this.baseMs = baseMs;
    this.factor = factor;
    this.maxMs = maxMs;
    this.jitter = jitter;
  }

  shouldRetry(attemptsMade) {
    return attemptsMade < this.maxAttempts;
  }

  nextDelay(attemptsMade) {
    const raw = this.baseMs * Math.pow(this.factor, Math.max(0, attemptsMade - 1));
    const capped = Math.min(this.maxMs, raw);
    if (!this.jitter) return capped;
    return Math.floor(capped * (0.5 + Math.random() * 0.5)); // 50%-100% of capped
  }
}

module.exports = { RetryPolicy };
