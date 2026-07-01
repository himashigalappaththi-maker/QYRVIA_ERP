'use strict';

/**
 * ARI data model (Phase 30.1) - the canonical, internal shapes the ARI engine
 * computes over. Standalone + deterministic: every factory validates input and
 * returns a FROZEN plain object (no Date.now, no randomness), so the same input
 * always yields the same value. Dates are 'YYYY-MM-DD'; ranges are half-open
 * [date_from, date_to). Day-of-week is 0=Sun..6=Sat (UTC).
 *
 * No external dependencies, no DB, no OTA coupling. Persistence is a separate
 * concern (store/*); the engines only ever see these objects.
 */

const LEVELS = Object.freeze({ system: 0, property: 1, rate_plan: 2, channel: 3 });
const LEVEL_NAMES = Object.freeze(Object.keys(LEVELS));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function reqStr(v, name) { if (v == null || String(v) === '') throw new Error('ARI: ' + name + ' required'); return String(v); }
function reqDate(v, name) { const s = reqStr(v, name); if (!ISO_DATE.test(s)) throw new Error('ARI: ' + name + " must be 'YYYY-MM-DD'"); return s; }
function nonNegInt(v, name) { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error('ARI: ' + name + ' must be a non-negative integer'); return n; }
function nonNegNum(v, name) { const n = Number(v); if (!(n >= 0)) throw new Error('ARI: ' + name + ' must be >= 0'); return n; }

/** Deterministic day-of-week (0=Sun..6=Sat) for a 'YYYY-MM-DD' date, computed in UTC. */
function dayOfWeek(date) { return new Date(date + 'T00:00:00Z').getUTCDay(); }
/** Inclusive day count between two ISO dates (used for advance-window math). */
function daysBetween(fromDate, toDate) { return Math.round((Date.parse(toDate + 'T00:00:00Z') - Date.parse(fromDate + 'T00:00:00Z')) / 86400000); }
/** date is within the half-open rule window [date_from, date_to). */
function inWindow(date, date_from, date_to) { return date >= date_from && date < date_to; }

// ---- Room type -------------------------------------------------------------
function makeRoomType(f = {}) {
  return Object.freeze({
    propertyId: reqStr(f.propertyId, 'propertyId'),
    roomTypeId: reqStr(f.roomTypeId, 'roomTypeId'),
    code: reqStr(f.code, 'code'),
    name: f.name != null ? String(f.name) : f.code,
    totalUnits: nonNegInt(f.totalUnits != null ? f.totalUnits : 0, 'totalUnits')
  });
}

// ---- Rate plan (with occupancy + derived structure) ------------------------
function makeRatePlan(f = {}) {
  const std = nonNegInt(f.standardOccupancy != null ? f.standardOccupancy : 2, 'standardOccupancy');
  const max = nonNegInt(f.maxOccupancy != null ? f.maxOccupancy : std, 'maxOccupancy');
  if (max < std) throw new Error('ARI: maxOccupancy must be >= standardOccupancy');
  // occupancyRates: { [occupancyCount]: absoluteAmount } (overrides baseRate for that occupancy)
  const occ = {};
  for (const [k, v] of Object.entries(f.occupancyRates || {})) occ[nonNegInt(k, 'occupancy')] = nonNegNum(v, 'occupancyRate');
  // childRates: [{ maxAge, amount }] sorted ascending by maxAge (deterministic)
  const child = (f.childRates || []).map((c) => ({ maxAge: nonNegInt(c.maxAge, 'child.maxAge'), amount: nonNegNum(c.amount, 'child.amount') }))
    .sort((a, b) => a.maxAge - b.maxAge);
  return Object.freeze({
    propertyId: reqStr(f.propertyId, 'propertyId'),
    ratePlanId: reqStr(f.ratePlanId, 'ratePlanId'),
    roomTypeId: reqStr(f.roomTypeId, 'roomTypeId'),
    code: reqStr(f.code, 'code'),
    name: f.name != null ? String(f.name) : f.code,
    currency: (f.currency || 'LKR').toUpperCase(),
    baseRate: nonNegNum(f.baseRate != null ? f.baseRate : 0, 'baseRate'),
    standardOccupancy: std,
    maxOccupancy: max,
    extraAdultAmount: nonNegNum(f.extraAdultAmount != null ? f.extraAdultAmount : 0, 'extraAdultAmount'),
    occupancyRates: Object.freeze(occ),
    childRates: Object.freeze(child)
  });
}

// ---- Inventory grid cell ---------------------------------------------------
function makeInventoryCell(f = {}) {
  const physical = nonNegInt(f.physical != null ? f.physical : 0, 'physical');
  const sold = nonNegInt(f.sold != null ? f.sold : 0, 'sold');
  const blocked = nonNegInt(f.blocked != null ? f.blocked : 0, 'blocked');
  const overbookingBuffer = nonNegInt(f.overbookingBuffer != null ? f.overbookingBuffer : 0, 'overbookingBuffer');
  return Object.freeze({
    propertyId: reqStr(f.propertyId, 'propertyId'),
    roomTypeId: reqStr(f.roomTypeId, 'roomTypeId'),
    date: reqDate(f.date, 'date'),
    physical, sold, blocked, overbookingBuffer,
    stopSell: !!f.stopSell
  });
}

// ---- Rate rule (date-scoped price modifier) --------------------------------
// kind: 'seasonal' (absolute amount for the window) | 'dow' (absolute for matching dow) | 'override' (absolute)
// amount XOR pct (pct = percentage OF base, e.g. 120 => +20%). dow optional [0..6].
function makeRateRule(f = {}) {
  return makeRule('rate', f, () => {
    if (f.amount == null && f.pct == null) throw new Error('ARI: rateRule needs amount or pct');
    return {
      kind: f.kind || 'override',
      amount: f.amount != null ? nonNegNum(f.amount, 'rateRule.amount') : null,
      pct: f.pct != null ? nonNegNum(f.pct, 'rateRule.pct') : null
    };
  });
}

// ---- LOS pricing (length-of-stay) ------------------------------------------
function makeLosPricing(f = {}) {
  return Object.freeze({
    propertyId: reqStr(f.propertyId, 'propertyId'),
    ratePlanId: reqStr(f.ratePlanId, 'ratePlanId'),
    los: (function () { const n = Number(f.los); if (!Number.isInteger(n) || n < 1) throw new Error('ARI: los must be a positive integer'); return n; })(),
    amount: f.amount != null ? nonNegNum(f.amount, 'losPricing.amount') : null,
    pct: f.pct != null ? nonNegNum(f.pct, 'losPricing.pct') : null
  });
}

// ---- Restriction rule ------------------------------------------------------
function makeRestrictionRule(f = {}) {
  return makeRule('restriction', f, () => ({
    cta: f.cta != null ? !!f.cta : null,
    ctd: f.ctd != null ? !!f.ctd : null,
    minLos: f.minLos != null ? nonNegInt(f.minLos, 'minLos') : null,
    maxLos: f.maxLos != null ? nonNegInt(f.maxLos, 'maxLos') : null,
    stayThrough: f.stayThrough != null ? !!f.stayThrough : null,
    minAdvanceDays: f.minAdvanceDays != null ? nonNegInt(f.minAdvanceDays, 'minAdvanceDays') : null,
    maxAdvanceDays: f.maxAdvanceDays != null ? nonNegInt(f.maxAdvanceDays, 'maxAdvanceDays') : null
  }));
}

// shared rule envelope: level + scope (roomTypeId/ratePlanId/channel) + window + dow + priority + a stable id
function makeRule(type, f, payloadFn) {
  const level = String(f.level || 'system');
  if (!(level in LEVELS)) throw new Error('ARI: invalid rule level ' + level);
  const dow = f.dow != null ? Object.freeze([...new Set(f.dow.map((d) => nonNegInt(d, 'dow')))].filter((d) => d <= 6).sort((a, b) => a - b)) : null;
  const base = {
    type,
    id: reqStr(f.id, 'rule.id'),
    level,
    levelRank: LEVELS[level],
    propertyId: reqStr(f.propertyId, 'propertyId'),
    roomTypeId: f.roomTypeId != null ? String(f.roomTypeId) : null,
    ratePlanId: f.ratePlanId != null ? String(f.ratePlanId) : null,
    channel: f.channel != null ? String(f.channel) : null,
    date_from: reqDate(f.date_from, 'date_from'),
    date_to: reqDate(f.date_to, 'date_to'),
    dow,
    priority: Number(f.priority || 0)
  };
  if (base.date_to <= base.date_from) throw new Error('ARI: date_to must be after date_from (half-open)');
  return Object.freeze(Object.assign(base, payloadFn()));
}

// ---- Internal channel mapping ----------------------------------------------
function makeChannelMapping(f = {}) {
  return Object.freeze({
    propertyId: reqStr(f.propertyId, 'propertyId'),
    channel: reqStr(f.channel, 'channel'),
    roomTypeId: reqStr(f.roomTypeId, 'roomTypeId'),
    ratePlanId: reqStr(f.ratePlanId, 'ratePlanId'),
    otaRoomId: f.otaRoomId != null ? String(f.otaRoomId) : null,
    otaRatePlanId: f.otaRatePlanId != null ? String(f.otaRatePlanId) : null,
    enabled: f.enabled != null ? !!f.enabled : true
  });
}

module.exports = {
  LEVELS, LEVEL_NAMES, ISO_DATE,
  dayOfWeek, daysBetween, inWindow,
  makeRoomType, makeRatePlan, makeInventoryCell,
  makeRateRule, makeLosPricing, makeRestrictionRule,
  makeChannelMapping
};
