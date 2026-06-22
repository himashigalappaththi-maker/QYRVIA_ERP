'use strict';

/**
 * Allocation commands (Phase 7 / C7).
 *   pms.allocation.create
 *   pms.allocation.release            (manual)
 *   pms.allocation.release_sweep      (system-triggered, idempotent)
 */

const { makeEvent } = require('../../core/event');

function makeAllocationCommands({ pmsRepo, allocationService }) {
  if (!pmsRepo)            throw new Error('pmsRepo required');
  if (!allocationService)  throw new Error('allocationService required');
  const cmds = [];

  cmds.push({
    name: 'pms.allocation.create',
    aggregateType: 'allocation',
    permission: 'allocation.write',
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.room_type_id || !input.date_from || !input.date_to || !Number.isInteger(input.qty_blocked))
        return { ok: false, error: 'missing_required' };
      if (input.qty_blocked < 1) return { ok: false, error: 'qty_blocked_must_be_positive' };
      try {
        const row = await pmsRepo.insertAllocation({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          contract_id: input.contract_id || null,
          partner_guest_id: input.partner_guest_id || null,
          room_type_id: input.room_type_id,
          date_from: input.date_from, date_to: input.date_to,
          qty_blocked: input.qty_blocked, qty_consumed: 0,
          release_days: input.release_days || 0,
          status: 'ACTIVE', notes: input.notes || null, created_by: ctx.actorId
        });
        return { ok: true, result: { id: row.id, qty_blocked: row.qty_blocked }, events: [
          makeEvent({ type: 'allocation.created', aggregateType: 'allocation',
            aggregateId: row.id,
            payload: { room_type_id: row.room_type_id, qty_blocked: row.qty_blocked,
                       date_from: row.date_from, date_to: row.date_to,
                       release_days: row.release_days, property_id: ctx.propertyId }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  cmds.push({
    name: 'pms.allocation.release',
    aggregateType: 'allocation',
    permission: 'allocation.release',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.allocation_id) return { ok: false, error: 'allocation_id_required' };
      const out = await allocationService.release({
        tenantId: ctx.tenantId, allocationId: input.allocation_id,
        ctx, reason: input.reason || 'manual_release'
      });
      if (!out.ok) return { ok: false, error: out.error };
      // The service emitted the allocation.released event; we just return.
      return { ok: true, result: { id: out.allocation.id, status: out.allocation.status } };
    }
  });

  // The sweep command is registered without `permission` so the system-
  // scheduled job handler (running as 'system' role) can dispatch it.
  cmds.push({
    name: 'pms.allocation.release_sweep',
    aggregateType: 'allocation',
    permission: 'allocation.release',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      const out = await allocationService.sweepReleases({ asOfDate: input.as_of_date || ctx.businessDate });
      return { ok: true, result: { released_count: out.released.length },
               events: [ makeEvent({ type: 'allocation.sweep_completed', aggregateType: 'allocation',
                 aggregateId: ctx.propertyId || 'system',
                 payload: { released_count: out.released.length,
                            as_of_date: input.as_of_date || ctx.businessDate || null }, ctx }) ]};
    }
  });

  return cmds;
}

module.exports = { makeAllocationCommands };
