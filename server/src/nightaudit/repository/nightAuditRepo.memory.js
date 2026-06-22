'use strict';

/**
 * In-memory Night Audit repository (default backing). Property-scoped. Owns
 * business dates, audit runs, financial locks, audit exceptions, and the
 * event-fed activity tally used by validation.
 */

function buildMemoryNightAuditRepo() {
  const businessDates = new Map();   // propertyId -> BusinessDate
  const runs = [];                   // NightAuditRun[]
  const locks = new Map();           // propertyId -> FinancialLock
  const exceptions = [];             // exception records
  const activity = new Map();        // propertyId -> { staysEnded, invoicesFinalized, paymentsReceived, tasksCompleted }

  const blankActivity = () => ({ staysEnded: 0, invoicesFinalized: 0, paymentsReceived: 0, tasksCompleted: 0 });

  return {
    async getBusinessDate(propertyId) { const b = businessDates.get(propertyId); return b ? Object.assign({}, b) : null; },
    async saveBusinessDate(bd) { businessDates.set(bd.propertyId, Object.assign({}, bd)); return Object.assign({}, bd); },
    async listBusinessDates() { return Array.from(businessDates.values()).map((b) => Object.assign({}, b)); },

    async insertRun(run) { runs.push(Object.assign({}, run)); return Object.assign({}, run); },
    async updateRun(id, patch) { const r = runs.find((x) => x.id === id); if (!r) return null; Object.assign(r, patch); return Object.assign({}, r); },
    async getRun(propertyId, id) { const r = runs.find((x) => x.id === id && x.propertyId === propertyId); return r ? Object.assign({}, r) : null; },
    async listRuns(propertyId, filter = {}) {
      return runs.filter((r) => r.propertyId === propertyId && (!filter.status || r.status === filter.status))
        .map((r) => Object.assign({}, r));
    },

    async getLock(propertyId) { const l = locks.get(propertyId); return l ? Object.assign({}, l) : null; },
    async saveLock(lock) { locks.set(lock.propertyId, Object.assign({}, lock)); return Object.assign({}, lock); },

    async insertException(ex) { exceptions.push(Object.assign({}, ex)); return Object.assign({}, ex); },
    async updateException(id, patch) { const e = exceptions.find((x) => x.id === id); if (!e) return null; Object.assign(e, patch); return Object.assign({}, e); },
    async listExceptions(propertyId, filter = {}) {
      return exceptions.filter((e) => e.propertyId === propertyId
        && (!filter.resolved === undefined || true)
        && (filter.resolved == null || e.resolved === filter.resolved)
        && (!filter.category || e.category === filter.category))
        .map((e) => Object.assign({}, e));
    },

    async getActivity(propertyId) { return Object.assign(blankActivity(), activity.get(propertyId) || {}); },
    async bumpActivity(propertyId, key, by = 1) {
      const a = Object.assign(blankActivity(), activity.get(propertyId) || {});
      a[key] = (a[key] || 0) + by;
      activity.set(propertyId, a);
      return Object.assign({}, a);
    },
    async resetActivity(propertyId) { activity.set(propertyId, blankActivity()); }
  };
}

module.exports = { buildMemoryNightAuditRepo };
