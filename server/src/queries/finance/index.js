'use strict';

/**
 * Finance query bundle (Phase 8).
 *
 *   const { makeQueries } = require('./queries/finance');
 *   const qs = makeQueries({ costCenterRepo, revenueMapRepo, ledgerRepo });
 *   qs.forEach((q) => queryBus.register(q));
 */

function makeQueries({ costCenterRepo, revenueMapRepo, ledgerRepo }) {
  const list = [];

  // ---- Cost centers ---------------------------------------------------
  if (costCenterRepo) {
    list.push({
      name: 'finance.cost_center.list', resourceType: 'cost_center', permission: 'cost_center.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        return { ok: true, data: await costCenterRepo.listCostCenters(ctx.tenantId, ctx.propertyId,
          { activeOnly: !!input.active_only }) };
      }
    });
    list.push({
      name: 'finance.cost_center.byId', resourceType: 'cost_center', permission: 'cost_center.read',
      async handler(input, ctx) {
        if (!input.id) return { ok: false, error: 'id_required' };
        const row = await costCenterRepo.findCostCenterById(ctx.tenantId, input.id);
        return row ? { ok: true, data: row } : { ok: false, error: 'not_found' };
      }
    });
  }

  // ---- Revenue posting map -------------------------------------------
  if (revenueMapRepo) {
    list.push({
      name: 'finance.revenue_map.list', resourceType: 'revenue_map', permission: 'revenue_map.read',
      async handler(input, ctx) {
        if (!ctx.propertyId) return { ok: false, error: 'property_required' };
        return { ok: true, data: await revenueMapRepo.listRevenueMaps(ctx.tenantId, ctx.propertyId) };
      }
    });
  }

  // ---- Ledger --------------------------------------------------------
  if (ledgerRepo) {
    list.push({
      name: 'finance.ledger.by_reference', resourceType: 'ledger_entry', permission: 'ledger.read',
      async handler(input, ctx) {
        if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
        if (!input.reference_type || !input.reference_id) return { ok: false, error: 'reference_required' };
        return { ok: true, data: await ledgerRepo.findLedgerByReference(ctx.tenantId, input.reference_type, input.reference_id) };
      }
    });
    list.push({
      name: 'finance.cost_center.report', resourceType: 'cost_center', permission: 'ledger.read',
      async handler(input, ctx) {
        if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
        return { ok: true, data: await ledgerRepo.reportByCostCenter(ctx.tenantId, ctx.propertyId,
          { dateFrom: input.date_from, dateTo: input.date_to }) };
      }
    });
    list.push({
      name: 'finance.revenue.summary', resourceType: 'ledger_entry', permission: 'ledger.read',
      async handler(input, ctx) {
        if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
        return { ok: true, data: await ledgerRepo.revenueSummary(ctx.tenantId, ctx.propertyId,
          { dateFrom: input.date_from, dateTo: input.date_to }) };
      }
    });
  }

  return list;
}

module.exports = { makeQueries };
