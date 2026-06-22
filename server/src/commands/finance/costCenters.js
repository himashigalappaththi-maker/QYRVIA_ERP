'use strict';

/**
 * Cost Center commands (Phase 8 / C11).
 *
 *   finance.cost_center.create
 *   finance.cost_center.update
 *   finance.cost_center.disable
 *
 * Property-scoped; cross-property cost-center IDs are refused at the
 * lookup point in any downstream consumer (ledgerService.prepareForEvent).
 */

const { makeEvent } = require('../../core/event');

const TYPES = ['ROOM','FNB','SPA','ADMIN','OTHER'];

function makeCostCenterCommands({ costCenterRepo }) {
  if (!costCenterRepo) throw new Error('costCenterRepo required');
  const cmds = [];

  cmds.push({
    name: 'finance.cost_center.create',
    aggregateType: 'cost_center',
    permission: 'cost_center.write',
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.code || !input.name || !input.type) return { ok: false, error: 'missing_required' };
      if (!TYPES.includes(input.type)) return { ok: false, error: 'invalid_type' };
      try {
        const row = await costCenterRepo.insertCostCenter({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          code: input.code, name: input.name, type: input.type,
          description: input.description || null,
          is_active: input.is_active !== false,
          created_by: ctx.actorId
        });
        return { ok: true, result: { id: row.id, code: row.code, type: row.type }, events: [
          makeEvent({ type: 'cost_center.created', aggregateType: 'cost_center', aggregateId: row.id,
            payload: { code: row.code, name: row.name, type: row.type, property_id: ctx.propertyId }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  cmds.push({
    name: 'finance.cost_center.update',
    aggregateType: 'cost_center',
    permission: 'cost_center.write',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.id) return { ok: false, error: 'id_required' };
      if (input.type && !TYPES.includes(input.type)) return { ok: false, error: 'invalid_type' };
      const before = await costCenterRepo.findCostCenterById(ctx.tenantId, input.id);
      if (!before) return { ok: false, error: 'cost_center_not_found' };
      const updated = await costCenterRepo.updateCostCenter(ctx.tenantId, input.id, {
        name: input.name, type: input.type, description: input.description
      });
      return { ok: true, result: { id: updated.id }, events: [
        makeEvent({ type: 'cost_center.updated', aggregateType: 'cost_center', aggregateId: updated.id,
          payload: { code: updated.code }, ctx })
      ]};
    }
  });

  cmds.push({
    name: 'finance.cost_center.disable',
    aggregateType: 'cost_center',
    permission: 'cost_center.write',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.id) return { ok: false, error: 'id_required' };
      const updated = await costCenterRepo.setCostCenterActive(ctx.tenantId, input.id, false);
      if (!updated) return { ok: false, error: 'cost_center_not_found' };
      return { ok: true, result: { id: updated.id, is_active: false }, events: [
        makeEvent({ type: 'cost_center.disabled', aggregateType: 'cost_center', aggregateId: updated.id,
          payload: { code: updated.code }, ctx })
      ]};
    }
  });

  return cmds;
}

module.exports = { makeCostCenterCommands };
