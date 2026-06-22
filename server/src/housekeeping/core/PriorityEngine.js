'use strict';

/**
 * PriorityEngine - deterministic priority scoring (0-100). No AI.
 *
 * Higher = clean sooner. Weights are fixed and documented; the score is a
 * clamped weighted sum of operational signals.
 */

const WEIGHTS = Object.freeze({
  arrivingGuestToday: 30,
  earlyCheckInRisk: 20,
  vipGuest: 25,
  suiteCategory: 10,
  checkoutCompleted: 10,
  maintenanceDependency: 5
  // occupancyPressure (0..1) contributes up to +20 (handled below)
});

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function score(factors = {}) {
  let s = 0;
  for (const key of Object.keys(WEIGHTS)) {
    if (factors[key]) s += WEIGHTS[key];
  }
  const pressure = clamp(Number(factors.occupancyPressure) || 0, 0, 1);
  s += Math.round(20 * pressure);
  return clamp(Math.round(s), 0, 100);
}

module.exports = { score, WEIGHTS };
