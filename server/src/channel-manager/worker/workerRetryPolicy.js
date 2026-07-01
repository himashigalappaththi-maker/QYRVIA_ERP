'use strict';

/**
 * Worker retry policy (Phase 24 B6).
 *
 * Backoff schedule: 1m -> 5m -> 15m -> 60m, then dead-letter.
 * next(retryCount) returns the decision for a job that has already failed
 * `retryCount` times: { retry, delayMs, attempt }.
 */

const BACKOFF_MS = Object.freeze([60000, 300000, 900000, 3600000]); // 1m, 5m, 15m, 60m

function buildWorkerRetryPolicy({ backoff = BACKOFF_MS } = {}) {
  return {
    backoff,
    maxRetries: backoff.length,
    next(retryCount) {
      const n = retryCount || 0;
      if (n < backoff.length) return { retry: true, delayMs: backoff[n], attempt: n + 1 };
      return { retry: false, delayMs: null, attempt: n + 1 };
    }
  };
}

module.exports = { buildWorkerRetryPolicy, BACKOFF_MS };
