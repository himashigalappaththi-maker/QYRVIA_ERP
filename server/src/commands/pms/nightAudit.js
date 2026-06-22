'use strict';

/**
 * Night Audit commands (Phase 5.5).
 *
 *   pms.night_audit.run
 *     - locks the property's business_date
 *     - executes registered subscriber steps
 *     - advances the business_date by one day
 *     - unlocks
 *
 * The command is `acceptsBusinessDateLocked: true` because it OWNS the
 * lock. It is NOT itself `accountingSensitive` (the lock is its own
 * coordination mechanism).
 */

const { makeEvent } = require('../../core/event');

function makeNightAuditCommands({ nightAuditService, nightAuditScheduler }) {
  if (!nightAuditService) throw new Error('nightAuditService required');
  const cmds = [];

  // Phase 6 / C13: schedule (or re-schedule) the recurring Night Audit job.
  if (nightAuditScheduler) {
    cmds.push({
      name: 'pms.night_audit.schedule',
      aggregateType: 'night_audit',
      permission: 'night_audit.config',
      async handler(input, ctx) {
        if (!ctx || !ctx.tenantId)   return { ok: false, error: 'tenant_required' };
        if (!ctx.propertyId)         return { ok: false, error: 'property_required' };
        const cron = input && input.cron;
        const tz   = (input && input.timezone) || 'UTC';
        if (!cron) return { ok: false, error: 'cron_required' };
        try {
          const job = await nightAuditScheduler.bootstrapForProperty({
            tenantId: ctx.tenantId, propertyId: ctx.propertyId,
            cron, timezone: tz, actorId: ctx.actorId
          });
          return { ok: true, result: { job_id: job.id, cron, timezone: tz }, events: [
            makeEvent({ type: 'night_audit.schedule_configured', aggregateType: 'night_audit',
              aggregateId: ctx.propertyId,
              payload: { property_id: ctx.propertyId, cron, timezone: tz, job_id: job.id }, ctx })
          ]};
        } catch (e) {
          return { ok: false, error: 'scheduler_rejected', detail: String(e && e.message || e) };
        }
      }
    });
  }

  cmds.push({
    name: 'pms.night_audit.run',
    aggregateType: 'night_audit',
    permission: 'night_audit.run',
    acceptsBusinessDateLocked: true,
    async handler(_input, ctx) {
      if (!ctx || !ctx.tenantId)   return { ok: false, error: 'tenant_required' };
      if (!ctx.propertyId)         return { ok: false, error: 'property_required' };
      if (!ctx.businessDate)       return { ok: false, error: 'business_date_required' };

      const startEv = makeEvent({
        type: 'night_audit.started', aggregateType: 'night_audit',
        aggregateId: ctx.propertyId,
        payload: { property_id: ctx.propertyId, business_date: ctx.businessDate }, ctx
      });

      const out = await nightAuditService.runForProperty({
        tenantId:   ctx.tenantId,
        propertyId: ctx.propertyId,
        businessDate: ctx.businessDate,
        triggeredBy: ctx.actorId || null,
        triggerKind: 'MANUAL'
      });

      if (!out.ok) {
        return { ok: false, error: out.error, detail: out.detail,
                 events: [startEv, makeEvent({
                   type: 'night_audit.failed', aggregateType: 'night_audit',
                   aggregateId: ctx.propertyId,
                   payload: { property_id: ctx.propertyId, business_date: ctx.businessDate,
                              error: out.detail, run_id: out.run_id }, ctx
                 })] };
      }

      const completedEv = makeEvent({
        type: 'night_audit.completed', aggregateType: 'night_audit',
        aggregateId: ctx.propertyId,
        payload: { property_id: ctx.propertyId,
                   business_date: ctx.businessDate,
                   next_business_date: out.run.next_business_date,
                   stats: out.stats }, ctx
      });

      return { ok: true, result: { run_id: out.run.id,
                                    business_date: ctx.businessDate,
                                    next_business_date: out.run.next_business_date,
                                    stats: out.stats },
               events: [startEv, completedEv] };
    }
  });

  return cmds;
}

module.exports = { makeNightAuditCommands };
