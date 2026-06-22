'use strict';

/**
 * Night Audit Scheduler (Phase 6 / C13).
 *
 * Wraps the Phase 3 generic scheduler:
 *   * bootstrapForProperty(propertyId, {cron, timezone})
 *       -> upserts a recurring scheduled_jobs row whose handler dispatches
 *          pms.night_audit.run at the configured time/timezone.
 *
 *   * registerStaleCheck({intervalCron})
 *       -> registers a single recurring job that sweeps the properties
 *          table for stale current_business_date values and emits
 *          business_date.stale_detected events.
 *
 * The scheduler service (Phase 3) already supports cron-based recurrence
 * (see migration 0015) - we only need to insert the rows.
 */

const { makeEvent } = require('../../core/event');

const JOB_TYPE_NIGHT_AUDIT = 'pms.night_audit.run';
const JOB_TYPE_STALE_CHECK = 'pms.business_date.stale_check';

function buildNightAuditScheduler({ schedulerRepo, scheduler, pmsRepo, eventBus, settingsService, commandBus }) {
  if (!schedulerRepo) throw new Error('schedulerRepo required');
  if (!scheduler)     throw new Error('scheduler required');

  async function bootstrapForProperty({ tenantId, propertyId, cron, timezone, actorId }) {
    if (!tenantId || !propertyId) throw new Error('tenantId+propertyId required');
    if (!cron) throw new Error('cron required');
    const tz = timezone || 'UTC';
    // We use the scheduler.scheduleJob API which already validates cron.
    const job = await scheduler.scheduleJob({
      tenantId, propertyId,
      jobType: JOB_TYPE_NIGHT_AUDIT,
      payload: { property_id: propertyId, source: 'auto_scheduler' },
      runAt: new Date(Date.now() + 60_000).toISOString(),     // first attempt in 60s; scheduler will compute next from cron
      maxAttempts: 3,
      recurrenceRule: cron,
      timezone: tz,
      createdBy: actorId || null
    });
    return job;
  }

  // Stale-business-date sweep. Designed to be called from a registered
  // scheduled-job handler. Pure: no commandBus dispatch - just emits an event.
  async function runStaleCheck({ thresholdHours } = {}) {
    if (typeof pmsRepo.listPropertiesWithStaleBusinessDate !== 'function') {
      // Optional helper; tests stub it.
      return { ok: true, found: 0 };
    }
    const threshold = Number.isFinite(thresholdHours) ? thresholdHours : 24;
    const stale = await pmsRepo.listPropertiesWithStaleBusinessDate(threshold);
    for (const p of stale) {
      try {
        await eventBus.publish(makeEvent({
          type: 'business_date.stale_detected', aggregateType: 'property',
          aggregateId: p.id,
          payload: {
            property_id: p.id,
            current_business_date: p.current_business_date,
            age_hours: p.age_hours,
            threshold_hours: threshold
          },
          ctx: { tenantId: p.tenant_id, propertyId: p.id, requestId: 'stale-check-' + Date.now() }
        }));
      } catch (_) { /* swallow per-row failures; the sweep continues */ }
    }
    return { ok: true, found: stale.length };
  }

  return {
    bootstrapForProperty,
    runStaleCheck,
    JOB_TYPE_NIGHT_AUDIT,
    JOB_TYPE_STALE_CHECK
  };
}

module.exports = { buildNightAuditScheduler, JOB_TYPE_NIGHT_AUDIT, JOB_TYPE_STALE_CHECK };
