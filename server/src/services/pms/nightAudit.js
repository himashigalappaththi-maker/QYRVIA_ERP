'use strict';

/**
 * Night Audit service (Phase 5.5).
 *
 * Responsibilities:
 *   1) Lock the property's business_date (sets properties.business_date_locked=true).
 *      The commandBus will refuse any command with `accountingSensitive:true`
 *      while the lock is held, EXCEPT commands marked `acceptsBusinessDateLocked:true`
 *      (only the audit pipeline itself).
 *   2) Insert a night_audit_runs row in status RUNNING.
 *   3) Run subscriber jobs (folio room-night posting, no-show flipping,
 *      occupancy snapshot, etc). Subscribers are registered via
 *      `service.registerStep(name, fn)` from later phases. For Phase 5.5
 *      no live subscribers exist - the audit shape is verified only.
 *   4) Advance properties.current_business_date by one day; unlock.
 *   5) Mark the run COMPLETED with stats. On any error, mark FAILED and
 *      LEAVE the property unlocked (so operations can resume).
 *
 * The service does NOT touch the commandBus directly; the calling command
 * does, and passes us a context object.
 */

function addDays(dateStr, n) {
  // dateStr 'YYYY-MM-DD' -> +n days, returned as 'YYYY-MM-DD' (UTC safe)
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildNightAuditService({ nightAuditRepo, pmsRepo }) {
  if (!nightAuditRepo) throw new Error('nightAuditRepo required');
  const steps = [];

  function registerStep(name, fn) {
    if (typeof fn !== 'function') throw new Error('step must be a function');
    steps.push({ name, fn });
  }

  async function runForProperty({ tenantId, propertyId, businessDate, triggeredBy, triggerKind }) {
    if (!tenantId || !propertyId)   throw new Error('tenantId+propertyId required');
    if (!businessDate)              throw new Error('businessDate required');

    const nextDate = addDays(businessDate, 1);

    // 1) lock the property's business date
    await nightAuditRepo.setPropertyBusinessDateLocked(tenantId, propertyId, true);

    // 2) insert RUNNING row (PENDING then immediately runs)
    const run = await nightAuditRepo.insertRun({
      tenant_id: tenantId, property_id: propertyId,
      business_date: businessDate, next_business_date: nextDate,
      status: 'RUNNING', triggered_by: triggeredBy || null,
      trigger_kind: triggerKind || (triggeredBy ? 'MANUAL' : 'AUTO')
    });

    const stats = {
      reservations_arrived: 0,
      reservations_departed: 0,
      reservations_no_show: 0,
      rooms_charged: 0,
      total_room_revenue: 0,
      steps: []
    };

    try {
      // 3) run subscriber steps. Each step receives a frozen context object
      //    and may MUTATE `stats` (rooms_charged etc).
      for (const s of steps) {
        const t0 = Date.now();
        try {
          await s.fn({ tenantId, propertyId, businessDate, nextBusinessDate: nextDate,
                       pmsRepo, stats });
          stats.steps.push({ name: s.name, ok: true, ms: Date.now() - t0 });
        } catch (err) {
          stats.steps.push({ name: s.name, ok: false, ms: Date.now() - t0,
                             error: String(err && err.message || err) });
          throw err;     // any subscriber failure aborts the audit
        }
      }

      // 4) advance business date + unlock
      await nightAuditRepo.advancePropertyBusinessDate(tenantId, propertyId, nextDate);

      // 5) complete the run
      const completed = await nightAuditRepo.completeRun(tenantId, run.id, stats);
      return { ok: true, run: completed, stats };
    } catch (err) {
      // Unlock even on failure - we must not strand the property.
      try { await nightAuditRepo.setPropertyBusinessDateLocked(tenantId, propertyId, false); }
      catch (_) { /* swallow - reporting err is the priority */ }
      await nightAuditRepo.failRun(tenantId, run.id, err);
      return { ok: false, error: 'night_audit_failed',
               detail: String(err && err.message || err), run_id: run.id };
    }
  }

  return { registerStep, runForProperty, _steps: steps, _addDays: addDays };
}

module.exports = { buildNightAuditService };
