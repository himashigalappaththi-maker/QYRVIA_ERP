'use strict';

/**
 * Rate engine v2 (Phase 30.1) - pure + deterministic per-night pricing.
 *
 * Pipeline (fixed order => deterministic; documented so output is reproducible):
 *   1. base        = ratePlan.baseRate
 *   2. date rule   = highest-precedence matching rateRule (resolver):
 *                      amount -> REPLACES base ; pct -> multiplies (pctFactor)
 *   3. LOS pricing = best losPricing with los <= requested (largest):
 *                      amount -> REPLACES base ; pct -> multiplies
 *   4. occupancy   = if no amount-override fired AND occupancyRates[adults] set
 *                      -> nightBase = occupancyRates[adults]
 *                    else nightBase = base + extraAdultAmount * max(0, adults - standardOccupancy)
 *   5. children    = sum of the first childRate (sorted by maxAge) matching each child age
 *   6. nightRate   = round2(nightBase * pctFactor) + children
 *
 * "REPLACES base" means later absolute overrides win over earlier ones (LOS over
 * seasonal/dow). Percentages compose multiplicatively. Rounding is half-up to 2dp.
 */

const { winningRule } = require('./ruleResolver');

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function bestLos(losPricing, ratePlanId, los) {
  if (los == null) return null;
  let best = null;
  for (const lp of losPricing || []) {
    if (lp.ratePlanId !== ratePlanId) continue;
    if (lp.los > los) continue;
    if (best === null || lp.los > best.los) best = lp;
  }
  return best;
}

function childTotal(ratePlan, childrenAges) {
  let total = 0;
  for (const age of childrenAges || []) {
    const match = ratePlan.childRates.find((c) => Number(age) <= c.maxAge); // childRates sorted ascending
    if (match) total += match.amount;
  }
  return total;
}

/**
 * Quote one night.
 * ctx: { propertyId, roomTypeId, ratePlanId, channel, date }
 * opts: { adults, childrenAges, los, rateRules }
 */
function quoteNight(ratePlan, ctx, { adults, childrenAges = [], los = null, rateRules = [], losPricing = [] } = {}) {
  const adultCount = adults != null ? Number(adults) : ratePlan.standardOccupancy;
  let base = ratePlan.baseRate;
  let pctFactor = 1;
  let amountOverridden = false;

  const dateRule = winningRule(rateRules, ctx, (r) => r.amount != null || r.pct != null);
  if (dateRule) {
    if (dateRule.amount != null) { base = dateRule.amount; amountOverridden = true; }
    if (dateRule.pct != null) pctFactor *= dateRule.pct / 100;
  }

  const lp = bestLos(losPricing, ratePlan.ratePlanId, los);
  if (lp) {
    if (lp.amount != null) { base = lp.amount; amountOverridden = true; }
    if (lp.pct != null) pctFactor *= lp.pct / 100;
  }

  let nightBase;
  if (!amountOverridden && ratePlan.occupancyRates[adultCount] != null) {
    nightBase = ratePlan.occupancyRates[adultCount];
  } else {
    const extraAdults = Math.max(0, adultCount - ratePlan.standardOccupancy);
    nightBase = base + ratePlan.extraAdultAmount * extraAdults;
  }

  const children = childTotal(ratePlan, childrenAges);
  const rate = round2(nightBase * pctFactor) + round2(children);

  return {
    date: ctx.date,
    rate: round2(rate),
    currency: ratePlan.currency,
    breakdown: {
      base: round2(base), pctFactor, occupancy: adultCount,
      extraAdults: Math.max(0, adultCount - ratePlan.standardOccupancy),
      children: round2(children), amountOverridden, losApplied: lp ? lp.los : null
    }
  };
}

module.exports = { quoteNight, round2 };
