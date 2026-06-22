'use strict';

/**
 * SeasonalityEngine - deterministic calendar-based rate multiplier.
 * seasonalMultiplier = dayOfWeekWeight x monthFactor x holidayOverride,
 * clamped to a sane band. Config is per-property (defaults are neutral = 1.0).
 */

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function seasonalMultiplier(dateStr, config = {}) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return 1.0;
  const dow = d.getUTCDay();              // 0 Sun .. 6 Sat
  const month = d.getUTCMonth() + 1;      // 1..12
  const dowW = (config.dowWeights && config.dowWeights[dow] != null) ? Number(config.dowWeights[dow]) : 1.0;
  const monthF = (config.monthFactors && config.monthFactors[month] != null) ? Number(config.monthFactors[month]) : 1.0;
  const holiday = (config.holidays && config.holidays[dateStr] != null) ? Number(config.holidays[dateStr]) : 1.0;
  return clamp(round2(dowW * monthF * holiday), 0.5, 2.0);
}

module.exports = { seasonalMultiplier, round2, clamp };
