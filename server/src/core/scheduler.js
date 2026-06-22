'use strict';

/**
 * Scheduler / job runtime.
 *
 *   scheduleJob({tenantId, propertyId, jobType, payload, runAt, maxAttempts, createdBy}) -> { id }
 *   cancelJob(id, ctx) -> { ok }
 *   registerHandler(jobType, fn(payload, ctx))
 *   executeDueJobs(ctx)  -- pulls pending+due jobs, runs handlers, updates status
 *
 * DI: pass a repo with the SQL implementations (production passes pg-backed
 * repo from db/repos.js; tests pass an in-memory mock).
 *
 * Job lifecycle:
 *   pending -> running (lock) -> completed | failed (retry up to max_attempts) -> cancelled (manual)
 */

const { makeEvent } = require('./event');
const eventBus      = require('./eventBus');
const logger        = require('../config/logger');
const crypto        = require('crypto');
const { nextRun, parseCron } = require('./cron');

const WORKER_ID = 'worker-' + crypto.randomBytes(4).toString('hex');

function buildScheduler({ repo }) {
  if (!repo) throw new Error('buildScheduler: repo required');
  const handlers = new Map();

  function registerHandler(jobType, fn) {
    if (typeof fn !== 'function') throw new Error('registerHandler: fn required');
    handlers.set(jobType, fn);
  }

  async function scheduleJob({ tenantId, propertyId, jobType, payload, runAt, maxAttempts, createdBy, recurrenceRule, timezone }, ctx) {
    if (!tenantId)  throw new Error('scheduleJob: tenantId required');
    if (!jobType)   throw new Error('scheduleJob: jobType required');
    if (recurrenceRule) {
      // Validate cron expression up-front - fail fast on bad input.
      try { parseCron(recurrenceRule); }
      catch (e) { throw new Error('scheduleJob: invalid recurrence_rule: ' + e.message); }
    }
    const initialRunAt = (runAt instanceof Date) ? runAt.toISOString() :
      (runAt || (recurrenceRule ? nextRun(recurrenceRule) : new Date().toISOString()));
    const row = await repo.insertScheduledJob({
      tenant_id:        tenantId,
      property_id:      propertyId || null,
      job_type:         jobType,
      payload:          payload || {},
      run_at:           initialRunAt,
      max_attempts:     maxAttempts || 3,
      created_by:       createdBy || (ctx && ctx.actorId) || null,
      recurrence_rule:  recurrenceRule || null,
      timezone:         timezone || 'UTC',
      next_run_at:      recurrenceRule ? initialRunAt : null
    });
    if (ctx && ctx.requestId) {
      try {
        await eventBus.publish(makeEvent({
          type:          'job.scheduled',
          aggregateType: 'scheduled_job',
          aggregateId:   row.id,
          payload: { job_type: jobType, run_at: row.run_at, payload },
          ctx
        }));
      } catch (e) { logger.error({ err: e }, '[scheduler] failed to audit scheduleJob'); }
    }
    return { id: row.id };
  }

  async function cancelJob(jobId, ctx) {
    const r = await repo.cancelScheduledJob(jobId);
    if (!r) return { ok: false, error: 'not_found_or_not_cancellable' };
    if (ctx && ctx.requestId && ctx.tenantId) {
      try {
        await eventBus.publish(makeEvent({
          type:          'job.cancelled',
          aggregateType: 'scheduled_job',
          aggregateId:   jobId,
          payload:       {},
          ctx
        }));
      } catch (e) { logger.error({ err: e }, '[scheduler] failed to audit cancelJob'); }
    }
    return { ok: true };
  }

  /**
   * Pull pending jobs whose run_at <= now, mark them running, execute handler,
   * mark completed or failed. Returns { picked, completed, failed }.
   *
   * Intended to be called by an external trigger (cron/runner). No fake
   * execution - if a handler is missing, marks the job failed with reason.
   */
  async function executeDueJobs({ limit = 25 } = {}) {
    const jobs = await repo.claimDueJobs({ workerId: WORKER_ID, limit });
    let picked = jobs.length, completed = 0, failed = 0;
    for (const j of jobs) {
      const ctx = {
        tenantId:   j.tenant_id,
        propertyId: j.property_id || null,
        actorId:    j.created_by || null,
        requestId:  'job-' + j.id
      };
      const handler = handlers.get(j.job_type);
      if (!handler) {
        await repo.markJobFailed(j.id, 'handler_not_registered');
        try {
          await eventBus.publish(makeEvent({
            type:          'job.failed',
            aggregateType: 'scheduled_job',
            aggregateId:   j.id,
            payload:       { job_type: j.job_type, error: 'handler_not_registered' },
            ctx
          }));
        } catch (_) { /* swallow */ }
        failed++;
        continue;
      }
      try {
        await handler(j.payload || {}, ctx);
        // Recurring job? Compute next_run_at and reset the row to pending.
        if (j.recurrence_rule) {
          const next = nextRun(j.recurrence_rule);
          await repo.markJobCompletedAndReschedule(j.id, next);
        } else {
          await repo.markJobCompleted(j.id);
        }
        try {
          await eventBus.publish(makeEvent({
            type:          'job.completed',
            aggregateType: 'scheduled_job',
            aggregateId:   j.id,
            payload:       { job_type: j.job_type, recurring: !!j.recurrence_rule },
            ctx
          }));
        } catch (_) {}
        completed++;
      } catch (err) {
        const reachedMax = (j.attempts + 1) >= (j.max_attempts || 3);
        const finalState = reachedMax ? (j.recurrence_rule ? 'dead_letter' : 'failed') : 'pending';
        await repo.markJobFailed(j.id, String(err.message || err), reachedMax, finalState);
        try {
          await eventBus.publish(makeEvent({
            type:          'job.failed',
            aggregateType: 'scheduled_job',
            aggregateId:   j.id,
            payload:       { job_type: j.job_type, error: String(err.message || err), final: reachedMax, state: finalState },
            ctx
          }));
        } catch (_) {}
        failed++;
      }
    }
    return { picked, completed, failed };
  }

  return { scheduleJob, cancelJob, executeDueJobs, registerHandler, workerId: WORKER_ID };
}

module.exports = { buildScheduler };
