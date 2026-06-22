'use strict';

/**
 * NightAuditEngine - orchestrates the day-end transition.
 *
 * Flow: start run -> mark business date AUDIT_PENDING + lock accounting ->
 * validate -> (blocking & !force) FAIL and stay pending+locked (operations
 * continue) -> else advance business date, summarize, complete, unlock, emit.
 *
 * Locking at the START (not only after validation) enforces the QYRVIA rule:
 * while an audit is pending, accounting-sensitive functions are restricted but
 * all operational modules keep working.
 */

const { makeRun, RUN_STATUS } = require('../models/NightAuditModels');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildNightAuditEngine({ repo, businessDate, validation, lock, exceptions, eventBus, clock } = {}) {
  if (!repo || !businessDate || !validation || !lock || !exceptions) throw new Error('NightAuditEngine: dependencies required');
  const now = clock || (() => Date.now());
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType: 'night_audit', aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt state */ }
  }

  async function generateSummary(ctx, bd) {
    const a = await repo.getActivity(requireProperty(ctx));
    return { businessDate: bd.currentBusinessDate, staysEnded: a.staysEnded, invoicesFinalized: a.invoicesFinalized,
      paymentsReceived: a.paymentsReceived, tasksCompleted: a.tasksCompleted };
  }

  return {
    async validateDayEnd(ctx, opts = {}) { return validation.validate(ctx, opts); },

    async runNightAudit(ctx, { providers, force = false, trigger = 'MANUAL' } = {}) {
      const propertyId = requireProperty(ctx);
      const bd = await businessDate.getBusinessDate(ctx);
      if (!bd) throw new Error('business_date_not_initialized');

      const run = await repo.insertRun(makeRun({ propertyId, businessDate: bd.currentBusinessDate }));
      await emit('dayend.started', run.id, { run_id: run.id, property_id: propertyId, business_date: bd.currentBusinessDate, trigger }, ctx);
      await businessDate.markPending(ctx);
      await lock.lockAccountingFunctions(ctx, { businessDate: bd.currentBusinessDate });

      const result = await validation.validate(ctx, { providers });
      for (const w of result.warnings) {
        await exceptions.raise(ctx, { category: w.category, code: w.code, message: w.message, blocking: false, businessDate: bd.currentBusinessDate, source: 'VALIDATION' });
      }

      if (result.blocking.length > 0 && !force) {
        for (const b of result.blocking) {
          await exceptions.raise(ctx, { category: b.category, code: b.code, message: b.message, blocking: true, businessDate: bd.currentBusinessDate, source: 'VALIDATION' });
        }
        const failed = await repo.updateRun(run.id, { status: RUN_STATUS.FAILED, completedAt: new Date(now()).toISOString(), warnings: result.warnings, exceptions: result.blocking });
        // Remains AUDIT_PENDING + locked: accounting restricted, operations continue.
        return { ok: false, run: failed, blocking: result.blocking, warnings: result.warnings };
      }

      const summary = await generateSummary(ctx, bd);
      const advanced = await businessDate.markClosed(ctx);          // advance to next business date
      const completed = await repo.updateRun(run.id, { status: RUN_STATUS.COMPLETED, completedAt: new Date(now()).toISOString(), warnings: result.warnings, summary });
      await repo.resetActivity(propertyId);
      await lock.unlockAccountingFunctions(ctx);                    // permitted functions unlocked
      await emit('dayend.completed', run.id, { run_id: run.id, property_id: propertyId, closed_date: bd.currentBusinessDate, new_business_date: advanced.currentBusinessDate, summary }, ctx);
      return { ok: true, run: completed, businessDate: advanced, summary, warnings: result.warnings };
    },

    /** Reverse a completed run: re-open the closed business date (controlled). */
    async rollbackAudit(ctx, runId) {
      const propertyId = requireProperty(ctx);
      const run = await repo.getRun(propertyId, runId);
      if (!run) throw new Error('run_not_found');
      if (run.status !== RUN_STATUS.COMPLETED) throw new Error('run_not_rollback_eligible');
      await businessDate.reopen(ctx, run.businessDate);
      const rolled = await repo.updateRun(runId, { status: RUN_STATUS.ROLLED_BACK });
      return { ok: true, run: rolled, reopenedTo: run.businessDate };
    },

    async getAuditHistory(ctx, filter) { return repo.listRuns(requireProperty(ctx), filter || {}); }
  };
}

module.exports = { buildNightAuditEngine };
