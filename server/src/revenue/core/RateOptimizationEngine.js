'use strict';

/**
 * RateOptimizationEngine - the deterministic pricing calculator.
 *
 *   raw = baseRate x demandMultiplier x seasonalMultiplier x ruleMultiplier
 *   -> clamp to [minRate, maxRate]
 *   -> smooth toward previousRate (stability) + cap the per-day change
 *   -> clamp again
 *
 * Smoothing + the daily-change cap guarantee no oscillation / no sudden jumps.
 */

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function computeRate({ baseRate, demandMultiplier = 1, seasonalMultiplier = 1, ruleMultiplier = 1,
  minRate = 0, maxRate = Infinity, previousRate = null, smoothingFactor = 0.5, maxDailyChangePct = 0.2 } = {}) {
  const raw = Number(baseRate) * Number(demandMultiplier) * Number(seasonalMultiplier) * Number(ruleMultiplier);
  let rate = clamp(raw, minRate, maxRate);

  if (previousRate != null && Number(previousRate) > 0) {
    const prev = Number(previousRate);
    const smoothed = prev + (rate - prev) * clamp(Number(smoothingFactor), 0, 1);
    const maxChange = prev * Number(maxDailyChangePct);
    rate = clamp(smoothed, prev - maxChange, prev + maxChange);
    rate = clamp(rate, minRate, maxRate);
  }

  return { finalRate: round2(rate), raw: round2(raw), clamped: round2(clamp(raw, minRate, maxRate)) };
}

module.exports = { computeRate, round2, clamp };
