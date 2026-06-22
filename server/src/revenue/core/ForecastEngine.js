'use strict';

/**
 * ForecastEngine - deterministic occupancy / revenue forecasting. No ML.
 *
 * For each future date: predictedOccupancy = baselineOccupancy x seasonal x
 * pace, clamped 0..1; predictedADR = baselineADR x seasonal; RevPAR = ADR x
 * occupancy; revenue = RevPAR x capacity.
 */

const { seasonalMultiplier } = require('./SeasonalityEngine');

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function* dateRange(from, to) {
  let d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { yield d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000); }
}

function forecast({ dateFrom, dateTo, baselineOccupancy = 0, baselineAdr = 0, capacity = 0,
  seasonalityConfig = {}, paceFactor = 1, cancellationTrend = 0 } = {}) {
  const pace = clamp(Number(paceFactor) * (1 - clamp(Number(cancellationTrend), 0, 1)), 0, 2);
  const days = [];
  let totalRevenue = 0;
  let occSum = 0;
  let adrSum = 0;
  for (const date of dateRange(dateFrom, dateTo)) {
    const seasonal = seasonalMultiplier(date, seasonalityConfig);
    const occ = clamp(Number(baselineOccupancy) * seasonal * pace, 0, 1);
    const adr = round2(Number(baselineAdr) * seasonal);
    const revpar = round2(adr * occ);
    const revenue = round2(revpar * Number(capacity));
    days.push({ date, predictedOccupancy: round2(occ), projectedADR: adr, projectedRevPAR: revpar, projectedRevenue: revenue });
    totalRevenue += revenue; occSum += occ; adrSum += adr;
  }
  const n = days.length || 1;
  return {
    days,
    totalProjectedRevenue: round2(totalRevenue),
    avgOccupancy: round2(occSum / n),
    avgADR: round2(adrSum / n)
  };
}

module.exports = { forecast, dateRange };
