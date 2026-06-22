'use strict';

/**
 * Child Policy Engine.
 *
 *   evaluateChild(policy, ageYears)
 *     -> { category, stay_charge_pct, meal_charge_pct, counts_in_occupancy,
 *          requires_extra_bed, extra_bed_charge } | null (no matching category)
 *
 *   evaluateMany(policy, childAges) -> array of evaluations (one per child)
 *
 *   classifyParty({ adults, children, policy, roomType })
 *     -> { occupancy_total, extra_beds_needed, oversold:bool, reasons:[...] }
 *
 * "A child is NEVER a reservation holder" - this is enforced at the
 * commandBus layer (reservation.create refuses non-Adult holders). The engine
 * here only computes charges + occupancy / extra-bed needs once an
 * adult-held reservation has childAges supplied.
 *
 * Pure function: takes a policy object (with categories array) and inputs.
 * No DB access here; caller pre-loads the policy.
 */

function evaluateChild(policy, ageYears) {
  if (!policy || !Array.isArray(policy.categories)) return null;
  if (!Number.isFinite(ageYears) || ageYears < 0) return null;
  const c = policy.categories.find((cat) => ageYears >= cat.age_from && ageYears <= cat.age_to);
  if (!c) return null;
  return {
    category: c.code,
    name: c.name,
    stay_charge_pct: Number(c.stay_charge_pct) || 0,
    meal_charge_pct: Number(c.meal_charge_pct) || 0,
    counts_in_occupancy: !!c.counts_in_occupancy,
    requires_extra_bed:  !!c.requires_extra_bed,
    extra_bed_charge:    Number(c.extra_bed_charge) || 0
  };
}

function evaluateMany(policy, childAges) {
  if (!Array.isArray(childAges)) return [];
  return childAges.map((age) => evaluateChild(policy, age));
}

function classifyParty({ adults, children, policy, roomType }) {
  if (!Number.isInteger(adults) || adults < 1) {
    return { occupancy_total: 0, extra_beds_needed: 0, oversold: true,
             reasons: ['adults_required'] };
  }
  const reasons = [];
  let occupancy = adults;
  let extraBeds = 0;
  const evals = evaluateMany(policy, children || []);
  for (const e of evals) {
    if (!e) {
      reasons.push('child_age_outside_policy');
      // Defensive default: count child as occupying a bed
      occupancy++;
      extraBeds++;
      continue;
    }
    if (e.counts_in_occupancy) occupancy++;
    if (e.requires_extra_bed)  extraBeds++;
  }
  const rt = roomType || {};
  const maxAdults    = Number.isFinite(rt.max_adults)         ? rt.max_adults         : Infinity;
  const baseOcc      = Number.isFinite(rt.base_occupancy)     ? rt.base_occupancy     : Infinity;
  const maxChildren  = Number.isFinite(rt.max_children)       ? rt.max_children       : Infinity;
  const extraBedCap  = Number.isFinite(rt.extra_bed_capacity) ? rt.extra_bed_capacity : 0;

  if (adults > maxAdults)               reasons.push('exceeds_max_adults');
  if ((children || []).length > maxChildren) reasons.push('exceeds_max_children');
  if (extraBeds > extraBedCap)          reasons.push('exceeds_extra_bed_capacity');
  if (occupancy > baseOcc + extraBedCap) reasons.push('exceeds_total_capacity');

  return {
    occupancy_total: occupancy,
    extra_beds_needed: extraBeds,
    oversold: reasons.length > 0,
    reasons
  };
}

module.exports = { evaluateChild, evaluateMany, classifyParty };
