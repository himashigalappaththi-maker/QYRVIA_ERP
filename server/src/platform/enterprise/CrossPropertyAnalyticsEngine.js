'use strict';

/**
 * CrossPropertyAnalyticsEngine (Phase 18) - aggregates per-property performance
 * snapshots into cross-property occupancy/revenue comparison + benchmarking.
 * Deterministic; fed read-only from events (e.g. dayend.completed).
 */

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function buildCrossPropertyAnalyticsEngine() {
  const snapshots = new Map();   // propertyId -> { occupancy, revenue, demand, samples }

  return {
    record(propertyId, { occupancy = 0, revenue = 0, demand = 0 } = {}) {
      const s = snapshots.get(propertyId) || { occupancySum: 0, revenueSum: 0, demandSum: 0, samples: 0 };
      s.occupancySum += Number(occupancy) || 0;
      s.revenueSum += Number(revenue) || 0;
      s.demandSum += Number(demand) || 0;
      s.samples += 1;
      snapshots.set(propertyId, s);
      return Object.assign({}, s);
    },

    perProperty() {
      const out = [];
      for (const [propertyId, s] of snapshots) {
        out.push({ propertyId,
          avgOccupancy: s.samples ? round2(s.occupancySum / s.samples) : 0,
          totalRevenue: round2(s.revenueSum),
          avgDemand: s.samples ? round2(s.demandSum / s.samples) : 0,
          samples: s.samples });
      }
      return out;
    },

    aggregate(propertyIds) {
      const rows = this.perProperty().filter((r) => !propertyIds || propertyIds.includes(r.propertyId));
      const totalRevenue = round2(rows.reduce((s, r) => s + r.totalRevenue, 0));
      const avgOccupancy = rows.length ? round2(rows.reduce((s, r) => s + r.avgOccupancy, 0) / rows.length) : 0;
      const ranked = rows.slice().sort((a, b) => b.totalRevenue - a.totalRevenue);
      return { properties: rows, totalRevenue, avgOccupancy, topPerformer: ranked[0] ? ranked[0].propertyId : null, ranking: ranked.map((r) => r.propertyId) };
    }
  };
}

module.exports = { buildCrossPropertyAnalyticsEngine };
