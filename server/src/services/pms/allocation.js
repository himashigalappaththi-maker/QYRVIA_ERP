'use strict';

/**
 * Allocation lifecycle service (Phase 7 / C7).
 *
 *   consume({tenantId, allocationId, qty, ctx})
 *     -> { ok, allocation, exhausted? }
 *   release({tenantId, allocationId, ctx, reason?})
 *     -> { ok, allocation }
 *   sweepReleases({asOfDate})
 *     -> { ok, released: [{allocation_id, property_id, tenant_id}] }
 *
 * The subscriber wiring lives in src/index.js: on `reservation.created`
 * with an `allocation_id`, call consume(1); on `reservation.cancelled`
 * with an `allocation_id`, call decrement(1).
 */

const { makeEvent } = require('../../core/event');

function buildAllocationService({ pmsRepo, eventBus }) {
  if (!pmsRepo) throw new Error('pmsRepo required');

  async function consume({ tenantId, allocationId, qty, ctx }) {
    if (!tenantId || !allocationId) return { ok: false, error: 'missing_required' };
    const updated = await pmsRepo.consumeAllocation(tenantId, allocationId, Number.isInteger(qty) ? qty : 1);
    if (!updated) return { ok: false, error: 'allocation_exhausted_or_inactive' };
    const exhausted = updated.status === 'EXHAUSTED';
    if (eventBus && ctx) {
      try {
        await eventBus.publish(makeEvent({
          type: 'allocation.consumed', aggregateType: 'allocation', aggregateId: updated.id,
          payload: { qty_consumed: updated.qty_consumed, qty_blocked: updated.qty_blocked }, ctx
        }));
        if (exhausted) {
          await eventBus.publish(makeEvent({
            type: 'allocation.exhausted', aggregateType: 'allocation', aggregateId: updated.id,
            payload: { qty_blocked: updated.qty_blocked }, ctx
          }));
        }
      } catch (_) { /* event emit failure does not undo the consume */ }
    }
    return { ok: true, allocation: updated, exhausted };
  }

  async function decrement({ tenantId, allocationId, qty, ctx }) {
    if (!tenantId || !allocationId) return { ok: false, error: 'missing_required' };
    const updated = await pmsRepo.decrementAllocationConsumption(tenantId, allocationId, Number.isInteger(qty) ? qty : 1);
    if (!updated) return { ok: false, error: 'allocation_not_found' };
    if (eventBus && ctx) {
      try {
        await eventBus.publish(makeEvent({
          type: 'allocation.released_back', aggregateType: 'allocation', aggregateId: updated.id,
          payload: { qty_consumed: updated.qty_consumed, qty_blocked: updated.qty_blocked }, ctx
        }));
      } catch (_) { /* swallow */ }
    }
    return { ok: true, allocation: updated };
  }

  async function release({ tenantId, allocationId, ctx, reason }) {
    if (!tenantId || !allocationId) return { ok: false, error: 'missing_required' };
    const updated = await pmsRepo.releaseAllocation(tenantId, allocationId);
    if (!updated) return { ok: false, error: 'not_active_or_not_found' };
    if (eventBus && ctx) {
      try {
        await eventBus.publish(makeEvent({
          type: 'allocation.released', aggregateType: 'allocation', aggregateId: updated.id,
          payload: { reason: reason || null }, ctx
        }));
      } catch (_) { /* swallow */ }
    }
    return { ok: true, allocation: updated };
  }

  async function sweepReleases({ asOfDate }) {
    if (typeof pmsRepo.listAllocationsDueForRelease !== 'function') {
      return { ok: true, released: [] };
    }
    const due = await pmsRepo.listAllocationsDueForRelease(asOfDate || new Date().toISOString().slice(0, 10));
    const released = [];
    for (const a of due) {
      const updated = await pmsRepo.releaseAllocation(a.tenant_id, a.id);
      if (updated) {
        released.push({ allocation_id: updated.id, property_id: updated.property_id, tenant_id: updated.tenant_id });
        if (eventBus) {
          try {
            await eventBus.publish(makeEvent({
              type: 'allocation.released', aggregateType: 'allocation', aggregateId: updated.id,
              payload: { reason: 'auto_release_sweep' },
              ctx: { tenantId: updated.tenant_id, propertyId: updated.property_id, requestId: 'sweep-' + Date.now() }
            }));
          } catch (_) { /* swallow */ }
        }
      }
    }
    return { ok: true, released };
  }

  return { consume, decrement, release, sweepReleases };
}

module.exports = { buildAllocationService };
