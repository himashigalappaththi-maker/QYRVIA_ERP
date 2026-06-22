'use strict';

/**
 * PricingRuleEngine - applies strict, deterministic pricing rules and returns a
 * combined multiplier plus a per-rule impact breakdown. Floor/cap are enforced
 * downstream (RateOptimizationEngine clamp).
 *
 * Rule types: OCCUPANCY_THRESHOLD, LEAD_TIME, LENGTH_OF_STAY, SEASONAL,
 * EVENT_BASED. Each rule contributes a multiplicative factor.
 */

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function factorFor(rule, ctx) {
  switch (rule.type) {
    case 'OCCUPANCY_THRESHOLD':
      return (Number(ctx.occupancyPressure) || 0) >= Number(rule.threshold) ? Number(rule.factor) : 1;
    case 'LEAD_TIME': {
      const lt = Number(ctx.leadTimeDays);
      if (rule.shortDays != null && lt <= Number(rule.shortDays)) return Number(rule.shortFactor != null ? rule.shortFactor : rule.factor);
      if (rule.longDays != null && lt >= Number(rule.longDays)) return Number(rule.longFactor != null ? rule.longFactor : 1);
      return 1;
    }
    case 'LENGTH_OF_STAY':
      return (Number(ctx.lengthOfStay) || 0) >= Number(rule.minNights) ? Number(rule.factor) : 1;
    case 'EVENT_BASED':
      return ctx.isEvent ? Number(rule.factor) : 1;
    case 'SEASONAL':
      return Number(rule.factor) || 1;
    default:
      return 1;
  }
}

function evaluate({ rules = [], context = {} } = {}) {
  let multiplier = 1;
  const impacts = [];
  for (const rule of rules) {
    const f = factorFor(rule, context);
    if (f && f !== 1) { multiplier *= f; impacts.push({ type: rule.type, factor: round2(f) }); }
  }
  return { multiplier: round2(multiplier), impacts };
}

module.exports = { evaluate };
