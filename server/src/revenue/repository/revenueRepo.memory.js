'use strict';

/**
 * In-memory revenue repository (default backing). Property-scoped. Holds rate
 * plans, the event-fed demand window, historical day-end snapshots, locked
 * reservation rates, and audited manual overrides.
 */

function buildMemoryRevenueRepo() {
  const ratePlans = new Map();     // propertyId|roomTypeId -> ratePlan
  const demand = new Map();        // propertyId -> counters
  const history = [];              // { propertyId, businessDate, occupancy, adr, revenue }
  const locked = new Map();        // propertyId|reservationId -> rate
  const overrides = new Map();     // propertyId|roomTypeId|date -> override
  const seasonality = new Map();   // propertyId -> seasonality config
  const k = (...p) => p.join('|');

  const blankDemand = () => ({ reservationsCreated: 0, reservationsCancelled: 0, checkIns: 0, checkOuts: 0, roomRevenue: 0, roomsSold: 0, capacity: 0 });

  return {
    async getRatePlan(propertyId, roomTypeId) { const r = ratePlans.get(k(propertyId, roomTypeId)); return r ? Object.assign({}, r) : null; },
    async saveRatePlan(plan) { ratePlans.set(k(plan.propertyId, plan.roomTypeId), Object.assign({}, plan)); return Object.assign({}, plan); },

    async getDemand(propertyId) { return Object.assign(blankDemand(), demand.get(propertyId) || {}); },
    async setDemand(propertyId, d) { demand.set(propertyId, Object.assign(blankDemand(), d)); },
    async bumpDemand(propertyId, key, by = 1) {
      const d = Object.assign(blankDemand(), demand.get(propertyId) || {});
      d[key] = (d[key] || 0) + by; demand.set(propertyId, d); return Object.assign({}, d);
    },
    async resetDemandWindow(propertyId) {
      const d = Object.assign(blankDemand(), demand.get(propertyId) || {});
      // capacity persists; window counters reset on day rollover
      demand.set(propertyId, Object.assign(blankDemand(), { capacity: d.capacity }));
    },
    async setCapacity(propertyId, capacity) {
      const d = Object.assign(blankDemand(), demand.get(propertyId) || {});
      d.capacity = Number(capacity) || 0; demand.set(propertyId, d); return d;
    },

    async appendHistory(rec) { history.push(Object.assign({}, rec)); },
    async listHistory(propertyId) { return history.filter((h) => h.propertyId === propertyId).map((h) => Object.assign({}, h)); },

    async lockRate(propertyId, reservationId, rate) { locked.set(k(propertyId, reservationId), Number(rate)); },
    async getLockedRate(propertyId, reservationId) { const r = locked.get(k(propertyId, reservationId)); return r == null ? null : r; },

    async setOverride(o) { overrides.set(k(o.propertyId, o.roomTypeId, o.date), Object.assign({}, o)); return Object.assign({}, o); },
    async getOverride(propertyId, roomTypeId, date) { const o = overrides.get(k(propertyId, roomTypeId, date)); return o ? Object.assign({}, o) : null; },

    async getSeasonality(propertyId) { return seasonality.get(propertyId) || null; },
    async setSeasonality(propertyId, cfg) { seasonality.set(propertyId, Object.assign({}, cfg)); return Object.assign({}, cfg); }
  };
}

module.exports = { buildMemoryRevenueRepo };
