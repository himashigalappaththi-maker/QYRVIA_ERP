'use strict';

/**
 * NightAuditDashboard - executive + operations read views, plus the
 * "Business Date Not Closed / Night Audit Pending" banner.
 */

const { DATE_STATUS, RUN_STATUS } = require('../models/NightAuditModels');

function buildNightAuditDashboard({ repo, lock } = {}) {
  if (!repo) throw new Error('NightAuditDashboard: repo required');
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };

  return {
    async banner(ctx) {
      const bd = await repo.getBusinessDate(requireProperty(ctx));
      if (bd && bd.status === DATE_STATUS.AUDIT_PENDING) {
        return ['Business Date Not Closed', 'Night Audit Pending'];
      }
      return [];
    },

    async executiveView(ctx) {
      const propertyId = requireProperty(ctx);
      const bd = await repo.getBusinessDate(propertyId);
      const runs = await repo.listRuns(propertyId, {});
      const exceptions = await repo.listExceptions(propertyId, { resolved: false });
      return {
        currentBusinessDate: bd ? bd.currentBusinessDate : null,
        status: bd ? bd.status : null,
        pendingAudits: runs.filter((r) => [RUN_STATUS.RUNNING, RUN_STATUS.FAILED].includes(r.status)).length,
        auditHistory: runs.slice(-10),
        exceptions,
        lockStatus: lock ? (await lock.isLocked(ctx) ? 'LOCKED' : 'UNLOCKED') : 'UNKNOWN'
      };
    },

    async operationsView(ctx) {
      const propertyId = requireProperty(ctx);
      const runs = await repo.listRuns(propertyId, {});
      const latest = runs[runs.length - 1] || null;
      const pending = await repo.listExceptions(propertyId, { resolved: false });
      return {
        auditProgress: latest ? latest.status : 'NONE',
        validationResults: latest ? { warnings: latest.warnings || [], exceptions: latest.exceptions || [] } : null,
        pendingActions: pending.filter((e) => e.blocking)
      };
    }
  };
}

module.exports = { buildNightAuditDashboard };
