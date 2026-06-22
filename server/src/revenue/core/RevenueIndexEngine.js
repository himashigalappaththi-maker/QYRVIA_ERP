'use strict';

/**
 * RevenueIndexEngine - pure hospitality KPIs from Billing + Night Audit data.
 *   ADR = roomRevenue / roomsSold
 *   RevPAR = roomRevenue / roomsAvailable
 *   occupancy% = roomsSold / roomsAvailable
 * Plus simple deterministic trend (last vs first) over a history series.
 */

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function kpis({ roomsSold = 0, roomsAvailable = 0, roomRevenue = 0 } = {}) {
  const sold = Number(roomsSold) || 0;
  const avail = Number(roomsAvailable) || 0;
  const rev = Number(roomRevenue) || 0;
  return {
    adr: sold > 0 ? round2(rev / sold) : 0,
    revpar: avail > 0 ? round2(rev / avail) : 0,
    occupancyPct: avail > 0 ? round2((sold / avail) * 100) : 0,
    roomRevenue: round2(rev)
  };
}

/** Deterministic trend over a numeric series: direction + pct change. */
function trend(series = []) {
  if (!Array.isArray(series) || series.length < 2) return { direction: 'FLAT', changePct: 0 };
  const first = Number(series[0]) || 0;
  const last = Number(series[series.length - 1]) || 0;
  if (first === 0) return { direction: last > 0 ? 'UP' : 'FLAT', changePct: 0 };
  const changePct = round2(((last - first) / first) * 100);
  return { direction: changePct > 0 ? 'UP' : (changePct < 0 ? 'DOWN' : 'FLAT'), changePct };
}

module.exports = { kpis, trend, round2 };
