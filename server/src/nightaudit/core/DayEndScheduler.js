'use strict';

/**
 * DayEndScheduler - automatic + manual day-end execution and retry of failed
 * audits. It NEVER gates user login or operational modules (it only triggers
 * the NightAuditEngine); the operational-continuity rule is preserved.
 */

const { RUN_STATUS } = require('../models/NightAuditModels');

function buildDayEndScheduler({ nightAudit, repo, clock } = {}) {
  if (!nightAudit) throw new Error('DayEndScheduler: nightAudit required');
  if (!repo) throw new Error('DayEndScheduler: repo required');
  const now = clock || (() => Date.now());

  return {
    /** Operator-triggered run. */
    async runManual(ctx, opts = {}) {
      return nightAudit.runNightAudit(ctx, Object.assign({ trigger: 'MANUAL' }, opts));
    },

    /** Scheduled (cron) run for a single property. */
    async runAutomatic(ctx, opts = {}) {
      return nightAudit.runNightAudit(ctx, Object.assign({ trigger: 'AUTOMATIC' }, opts));
    },

    /**
     * Sweep: run an automatic day-end for every property whose business date is
     * behind `asOfDate`. `ctxFor(propertyId)` supplies a system ctx per property.
     */
    async runDue({ asOfDate, ctxFor, providersFor } = {}) {
      const results = [];
      const all = await repo.listBusinessDates();
      for (const bd of all) {
        if (bd.currentBusinessDate >= asOfDate) continue;       // already current
        const ctx = ctxFor(bd.propertyId);
        const providers = providersFor ? providersFor(bd.propertyId) : undefined;
        // eslint-disable-next-line no-await-in-loop
        const r = await nightAudit.runNightAudit(ctx, { trigger: 'AUTOMATIC', providers });
        results.push({ propertyId: bd.propertyId, ok: r.ok, runId: r.run && r.run.id });
      }
      return results;
    },

    /** Retry the most recent FAILED run for a property. */
    async retryFailed(ctx, opts = {}) {
      const failed = (await repo.listRuns(ctx.propertyId, { status: RUN_STATUS.FAILED }))
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      if (failed.length === 0) return { ok: false, error: 'no_failed_run' };
      return nightAudit.runNightAudit(ctx, Object.assign({ trigger: 'RETRY' }, opts));
    },

    _now: now
  };
}

module.exports = { buildDayEndScheduler };
