'use strict';

/**
 * Restriction engine (Phase 30.1) - pure + deterministic.
 *
 * Per-date restrictions are resolved field-by-field via the rule resolver (each
 * field takes the highest-precedence rule that defines it). Defaults when no rule
 * applies: cta=false, ctd=false, minLos=1, maxLos=null, stayThrough=false,
 * minAdvanceDays=0, maxAdvanceDays=null.
 *
 * Field meanings (OTA-standard):
 *   - CTA  : closed to arrival   (no stay may START on this date)
 *   - CTD  : closed to departure (no stay may END on this date)
 *   - MinLOS/MaxLOS : length-of-stay bounds, evaluated on the arrival date
 *   - stayThrough   : no arrival AND no departure on this date (pass-through ok)
 *   - min/maxAdvanceDays : booking window vs the booking date
 *
 * evaluateStay() applies these to a concrete [arrival, departure) request and
 * returns a deterministic bookable/blocked decision with explicit reasons.
 */

const { resolveField: _resolveField } = require('./ruleResolver');
const model = require('./model');

const DEFAULTS = Object.freeze({ cta: false, ctd: false, minLos: 1, maxLos: null, stayThrough: false, minAdvanceDays: 0, maxAdvanceDays: null });

/** Resolve all restriction fields for a single date. */
function restrictionsForDate(restrictionRules, ctx) {
  return {
    cta: _resolveField(restrictionRules, ctx, 'cta', DEFAULTS.cta),
    ctd: _resolveField(restrictionRules, ctx, 'ctd', DEFAULTS.ctd),
    minLos: _resolveField(restrictionRules, ctx, 'minLos', DEFAULTS.minLos),
    maxLos: _resolveField(restrictionRules, ctx, 'maxLos', DEFAULTS.maxLos),
    stayThrough: _resolveField(restrictionRules, ctx, 'stayThrough', DEFAULTS.stayThrough),
    minAdvanceDays: _resolveField(restrictionRules, ctx, 'minAdvanceDays', DEFAULTS.minAdvanceDays),
    maxAdvanceDays: _resolveField(restrictionRules, ctx, 'maxAdvanceDays', DEFAULTS.maxAdvanceDays)
  };
}

/**
 * Evaluate a concrete stay request against restrictions.
 * args: { propertyId, roomTypeId, ratePlanId, channel, arrival, departure, bookingDate? }
 * Returns { bookable, los, reasons[] } - deterministic.
 */
function evaluateStay(restrictionRules, args) {
  const { propertyId, roomTypeId, ratePlanId, channel, arrival, departure, bookingDate } = args;
  const los = model.daysBetween(arrival, departure);
  const reasons = [];
  if (los < 1) return { bookable: false, los, reasons: ['invalid_stay'] };

  const ctxAt = (date) => ({ propertyId, roomTypeId, ratePlanId, channel, date });
  const arr = restrictionsForDate(restrictionRules, ctxAt(arrival));
  const dep = restrictionsForDate(restrictionRules, ctxAt(departure));

  if (arr.cta) reasons.push('cta');
  if (arr.stayThrough) reasons.push('stay_through_arrival');
  if (dep.ctd) reasons.push('ctd');
  if (dep.stayThrough) reasons.push('stay_through_departure');
  if (los < arr.minLos) reasons.push('min_los');
  if (arr.maxLos != null && los > arr.maxLos) reasons.push('max_los');

  if (bookingDate != null) {
    const advance = model.daysBetween(bookingDate, arrival);
    if (advance < arr.minAdvanceDays) reasons.push('min_advance');
    if (arr.maxAdvanceDays != null && advance > arr.maxAdvanceDays) reasons.push('max_advance');
  }

  return { bookable: reasons.length === 0, los, reasons };
}

module.exports = { restrictionsForDate, evaluateStay, DEFAULTS };
