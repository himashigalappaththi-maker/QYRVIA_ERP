'use strict';

/**
 * ARI output contract (Phase 30.1) - the standardized, OTA-mappable JSON shape
 * the ARI engine emits. Deterministic: the contract carries NO timestamps or
 * generated ids, so the same input state always serializes identically. A later
 * channel mapping layer translates this neutral shape into each OTA's wire format
 * (Booking.com / Expedia / etc.).
 *
 * Shape:
 * {
 *   ari_version, property_id, channel|null, currency, date_from, date_to,
 *   room_types: [{
 *     room_type_id, code,
 *     availability: [{ date, available, stop_sell }],
 *     rate_plans:  [{ rate_plan_id, code, currency,
 *       days: [{ date, rate, restrictions:{cta,ctd,min_los,max_los,stay_through,min_advance_days,max_advance_days} }] }]
 *   }]
 * }
 */

const ARI_VERSION = '1.0';

function restrictionShape(r) {
  return {
    cta: !!r.cta, ctd: !!r.ctd,
    min_los: r.minLos != null ? r.minLos : 1,
    max_los: r.maxLos != null ? r.maxLos : null,
    stay_through: !!r.stayThrough,
    min_advance_days: r.minAdvanceDays != null ? r.minAdvanceDays : 0,
    max_advance_days: r.maxAdvanceDays != null ? r.maxAdvanceDays : null
  };
}

/** Validate the structural shape of an ARI output object (cheap, deterministic). */
function validateOutput(o) {
  const errors = [];
  if (!o || typeof o !== 'object') return { ok: false, errors: ['not_an_object'] };
  if (o.ari_version !== ARI_VERSION) errors.push('ari_version');
  for (const k of ['property_id', 'currency', 'date_from', 'date_to']) if (o[k] == null) errors.push('missing_' + k);
  if (!Array.isArray(o.room_types)) errors.push('room_types_not_array');
  for (const rt of o.room_types || []) {
    if (!rt.room_type_id) errors.push('room_type_id');
    if (!Array.isArray(rt.availability)) errors.push('availability_not_array');
    if (!Array.isArray(rt.rate_plans)) errors.push('rate_plans_not_array');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { ARI_VERSION, restrictionShape, validateOutput };
