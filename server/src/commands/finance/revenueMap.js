'use strict';

/**
 * Revenue Posting Map commands (Phase 8 / C12).
 *
 *   finance.revenue_map.upsert
 *   finance.revenue_map.delete
 *
 * The map is the ONLY place debit/credit account names are defined. Services
 * resolve every financial event through it (see ledgerService.postForEvent);
 * a missing mapping is a hard fail at posting time.
 */

const { makeEvent } = require('../../core/event');

function makeRevenueMapCommands({ revenueMapRepo, costCenterRepo }) {
  if (!revenueMapRepo) throw new Error('revenueMapRepo required');
  const cmds = [];

  cmds.push({
    name: 'finance.revenue_map.upsert',
    aggregateType: 'revenue_map',
    permission: 'revenue_map.write',
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.event_type)    return { ok: false, error: 'event_type_required' };
      if (!input.revenue_type)  return { ok: false, error: 'revenue_type_required' };
      if (!input.debit_account || !input.credit_account) return { ok: false, error: 'accounts_required' };
      if (input.debit_account === input.credit_account)  return { ok: false, error: 'accounts_must_differ' };

      // A pinned cost center, if supplied, must belong to this property.
      if (input.cost_center_id && costCenterRepo) {
        const cc = await costCenterRepo.findCostCenterById(ctx.tenantId, input.cost_center_id);
        if (!cc) return { ok: false, error: 'cost_center_not_found' };
        if (cc.property_id !== ctx.propertyId) return { ok: false, error: 'cost_center_property_mismatch' };
      }

      const row = await revenueMapRepo.upsertRevenueMap({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId,
        event_type: input.event_type, revenue_type: input.revenue_type,
        cost_center_id: input.cost_center_id || null,
        debit_account: input.debit_account, credit_account: input.credit_account,
        is_active: input.is_active !== false, description: input.description || null,
        created_by: ctx.actorId
      });
      return { ok: true, result: { id: row.id, event_type: row.event_type, revenue_type: row.revenue_type },
               events: [ makeEvent({ type: 'revenue_map.upserted', aggregateType: 'revenue_map',
                 aggregateId: row.id,
                 payload: { event_type: row.event_type, revenue_type: row.revenue_type,
                            debit_account: row.debit_account, credit_account: row.credit_account,
                            property_id: ctx.propertyId }, ctx }) ]};
    }
  });

  cmds.push({
    name: 'finance.revenue_map.delete',
    aggregateType: 'revenue_map',
    permission: 'revenue_map.write',
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.event_type) return { ok: false, error: 'event_type_required' };
      const existing = await revenueMapRepo.findRevenueMap(ctx.tenantId, ctx.propertyId, input.event_type);
      const count = await revenueMapRepo.deleteRevenueMap(ctx.tenantId, ctx.propertyId, input.event_type);
      if (!count) return { ok: false, error: 'mapping_not_found' };
      return { ok: true, result: { event_type: input.event_type, deleted: count },
               events: [ makeEvent({ type: 'revenue_map.deleted', aggregateType: 'revenue_map',
                 aggregateId: (existing && existing.id) || input.event_type,
                 payload: { event_type: input.event_type, property_id: ctx.propertyId }, ctx }) ]};
    }
  });

  return cmds;
}

module.exports = { makeRevenueMapCommands };
