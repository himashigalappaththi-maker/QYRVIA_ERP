'use strict';

/**
 * Meal Plan commands (Phase 6 / C4).
 *
 *   pms.mealplan.create
 *   pms.mealplan.attach_to_rateplan
 *
 * The aggregate is `meal_plan`. Permissions: pms.mealplan.write.
 * Property-scoped + audit-enabled like every other PMS write.
 */

const { makeEvent } = require('../../core/event');

const BASES = ['RO','BB','HB','FB','AI','CUSTOM'];

function _need(field, ctx) { if (!ctx || !ctx[field]) throw new Error(field + ' required'); }
function _str(v, name, max) { if (!v || typeof v !== 'string') throw new Error(name + ' required'); if (max && v.length > max) throw new Error(name + ' too long'); return v.trim(); }

function makeMealPlanCommands({ pmsRepo }) {
  if (!pmsRepo) throw new Error('makeMealPlanCommands: pmsRepo required');

  return [
    {
      name: 'pms.mealplan.create',
      aggregateType: 'meal_plan',
      permission: 'pms.mealplan.write',
      async handler(input, ctx) {
        _need('tenantId', ctx); _need('propertyId', ctx);
        try {
          const basis = input.basis || 'RO';
          if (!BASES.includes(basis)) return { ok: false, error: 'invalid_basis' };
          const code  = _str(input.code, 'code', 20);
          const name  = _str(input.name, 'name', 200);
          const row = await pmsRepo.insertMealPlan({
            tenant_id: ctx.tenantId, property_id: ctx.propertyId,
            code, name, basis,
            includes_breakfast: !!input.includes_breakfast,
            includes_lunch:     !!input.includes_lunch,
            includes_dinner:    !!input.includes_dinner,
            includes_snack:     !!input.includes_snack,
            adult_rate: input.adult_rate || 0,
            child_rate: input.child_rate || 0,
            currency:   input.currency || 'LKR',
            active:     input.active !== false,
            description: input.description || null,
            created_by:  ctx.actorId
          });
          return { ok: true, result: { id: row.id, code: row.code, basis: row.basis }, events: [
            makeEvent({ type: 'meal_plan.created', aggregateType: 'meal_plan', aggregateId: row.id,
              payload: { code, basis, includes_breakfast: row.includes_breakfast,
                         includes_lunch: row.includes_lunch, includes_dinner: row.includes_dinner,
                         includes_snack: row.includes_snack, property_id: ctx.propertyId }, ctx })
          ]};
        } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
      }
    },
    {
      name: 'pms.mealplan.attach_to_rateplan',
      aggregateType: 'rate_plan',
      permission: 'pms.mealplan.write',
      async handler(input, ctx) {
        _need('tenantId', ctx);
        if (!input.rate_plan_id) return { ok: false, error: 'rate_plan_id_required' };
        if (!input.meal_plan_id) return { ok: false, error: 'meal_plan_id_required' };
        const rp = await pmsRepo.findRatePlanById(ctx.tenantId, input.rate_plan_id);
        if (!rp) return { ok: false, error: 'rate_plan_not_found' };
        const mp = await pmsRepo.findMealPlanById(ctx.tenantId, input.meal_plan_id);
        if (!mp) return { ok: false, error: 'meal_plan_not_found' };
        if (rp.property_id !== mp.property_id) return { ok: false, error: 'property_mismatch' };
        const updated = await pmsRepo.attachMealPlanToRatePlan(ctx.tenantId, input.rate_plan_id, input.meal_plan_id);
        return { ok: true, result: { rate_plan_id: updated.id, meal_plan_id: updated.meal_plan_id }, events: [
          makeEvent({ type: 'rate_plan.meal_plan_linked', aggregateType: 'rate_plan', aggregateId: updated.id,
            payload: { rate_plan_id: updated.id, meal_plan_id: updated.meal_plan_id }, ctx })
        ]};
      }
    }
  ];
}

module.exports = { makeMealPlanCommands };
