'use strict';

/**
 * RateLimiterEngine (Phase 18) - deterministic fixed-window limiter keyed by
 * any dimension (user / property / endpoint category, or a composite). Prevents
 * API abuse, overload, and burst failures. Injectable clock for testability.
 */

function buildRateLimiterEngine({ clock } = {}) {
  const now = clock || (() => Date.now());
  const windows = new Map();   // key -> { count, windowStart }

  function check(key, { limit = 60, windowMs = 60000 } = {}) {
    const t = now();
    let w = windows.get(key);
    if (!w || (t - w.windowStart) >= windowMs) { w = { count: 0, windowStart: t }; windows.set(key, w); }
    if (w.count >= limit) {
      const retryAfterMs = w.windowStart + windowMs - t;
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    w.count += 1;
    return { allowed: true, remaining: limit - w.count, retryAfterMs: 0 };
  }

  function reset(key) { if (key) windows.delete(key); else windows.clear(); }

  return { check, reset };
}

module.exports = { buildRateLimiterEngine };
