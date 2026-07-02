'use strict';

/**
 * DB-backed ARI store (Phase 30.1). Implements the store contract by reading the
 * ari_* tables (migration 0049) and mapping rows -> model objects, so the engines
 * see the exact same shapes as the in-memory store. Writes are concurrency-safe:
 *   - upsert* bump `version` on conflict;
 *   - updateInventoryOptimistic() applies a patch only if `version` is unchanged
 *     (lost-update protection -> a stale writer gets {conflict:true});
 *   - adjustSold() is an atomic `sold = sold + delta` (no read-modify-write race).
 *
 * `db` is any { query(text, params) } - in production a tenant-scoped client so
 * FORCE RLS binds (the engine never sees another tenant's rows).
 */

const model = require('./../model');

function num(v) { return v == null ? null : Number(v); }

function buildDbAriStore({ db } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('dbAriStore: db.query required');
  const q = (text, params) => db.query(text, params).then((r) => r.rows);

  // ---- reads (-> model objects) --------------------------------------------
  async function roomTypes(pid) {
    const rows = await q('SELECT * FROM ari_room_type WHERE property_id=$1 ORDER BY room_type_id', [pid]);
    return rows.map((r) => model.makeRoomType({ propertyId: r.property_id, roomTypeId: r.room_type_id, code: r.code, name: r.name, totalUnits: r.total_units }));
  }
  async function ratePlans(pid) {
    const rows = await q('SELECT * FROM ari_rate_plan WHERE property_id=$1 ORDER BY rate_plan_id', [pid]);
    return rows.map((r) => model.makeRatePlan({
      propertyId: r.property_id, ratePlanId: r.rate_plan_id, roomTypeId: r.room_type_id, code: r.code, name: r.name,
      currency: r.currency, baseRate: num(r.base_rate), standardOccupancy: r.standard_occupancy, maxOccupancy: r.max_occupancy,
      extraAdultAmount: num(r.extra_adult_amount), occupancyRates: r.occupancy_rates || {}, childRates: r.child_rates || []
    }));
  }
  async function inventory(pid, from, to) {
    const rows = await q('SELECT * FROM ari_inventory_grid WHERE property_id=$1 AND date >= $2 AND date < $3 ORDER BY room_type_id, date', [pid, from, to]);
    return rows.map((r) => model.makeInventoryCell({ propertyId: r.property_id, roomTypeId: r.room_type_id, date: iso(r.date), physical: r.physical, sold: r.sold, blocked: r.blocked, overbookingBuffer: r.overbooking_buffer, stopSell: r.stop_sell }));
  }
  async function rateRules(pid) {
    const rows = await q('SELECT * FROM ari_rate_rule WHERE property_id=$1 ORDER BY id', [pid]);
    return rows.map((r) => model.makeRateRule({ id: r.id, level: r.level, propertyId: r.property_id, roomTypeId: r.room_type_id, ratePlanId: r.rate_plan_id, channel: r.channel, date_from: iso(r.date_from), date_to: iso(r.date_to), dow: r.dow, kind: r.kind, amount: num(r.amount), pct: num(r.pct), priority: r.priority }));
  }
  async function restrictionRules(pid) {
    const rows = await q('SELECT * FROM ari_restriction_rule WHERE property_id=$1 ORDER BY id', [pid]);
    return rows.map((r) => model.makeRestrictionRule({ id: r.id, level: r.level, propertyId: r.property_id, roomTypeId: r.room_type_id, ratePlanId: r.rate_plan_id, channel: r.channel, date_from: iso(r.date_from), date_to: iso(r.date_to), dow: r.dow, cta: r.cta, ctd: r.ctd, minLos: r.min_los, maxLos: r.max_los, stayThrough: r.stay_through, minAdvanceDays: r.min_advance_days, maxAdvanceDays: r.max_advance_days, priority: r.priority }));
  }
  async function losPricing(pid) {
    const rows = await q('SELECT * FROM ari_los_pricing WHERE property_id=$1 ORDER BY rate_plan_id, los', [pid]);
    return rows.map((r) => model.makeLosPricing({ propertyId: r.property_id, ratePlanId: r.rate_plan_id, los: r.los, amount: num(r.amount), pct: num(r.pct) }));
  }
  async function mappings(pid) {
    const rows = await q('SELECT * FROM ari_channel_mapping WHERE property_id=$1 ORDER BY channel, room_type_id, rate_plan_id', [pid]);
    return rows.map((r) => model.makeChannelMapping({ propertyId: r.property_id, channel: r.channel, roomTypeId: r.room_type_id, ratePlanId: r.rate_plan_id, otaRoomId: r.ota_room_id, otaRatePlanId: r.ota_rate_plan_id, enabled: r.enabled }));
  }

  // ---- writes (config + concurrency-safe inventory) ------------------------
  async function putRoomType(f) {
    const o = model.makeRoomType(f); const t = f.tenant_id;
    await db.query(`INSERT INTO ari_room_type (tenant_id, property_id, room_type_id, code, name, total_units)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, property_id, room_type_id) DO UPDATE SET code=EXCLUDED.code, name=EXCLUDED.name, total_units=EXCLUDED.total_units, version=ari_room_type.version+1, updated_at=now()`,
      [t, o.propertyId, o.roomTypeId, o.code, o.name, o.totalUnits]);
    return o;
  }
  async function putRatePlan(f) {
    const o = model.makeRatePlan(f); const t = f.tenant_id;
    await db.query(`INSERT INTO ari_rate_plan (tenant_id, property_id, rate_plan_id, room_type_id, code, name, currency, base_rate, standard_occupancy, max_occupancy, extra_adult_amount, occupancy_rates, child_rates)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (tenant_id, property_id, rate_plan_id) DO UPDATE SET base_rate=EXCLUDED.base_rate, occupancy_rates=EXCLUDED.occupancy_rates, child_rates=EXCLUDED.child_rates, version=ari_rate_plan.version+1, updated_at=now()`,
      [t, o.propertyId, o.ratePlanId, o.roomTypeId, o.code, o.name, o.currency, o.baseRate, o.standardOccupancy, o.maxOccupancy, o.extraAdultAmount, JSON.stringify(o.occupancyRates), JSON.stringify(o.childRates)]);
    return o;
  }
  async function putInventoryCell(f) {
    const o = model.makeInventoryCell(f); const t = f.tenant_id;
    const r = await db.query(`INSERT INTO ari_inventory_grid (tenant_id, property_id, room_type_id, date, physical, sold, blocked, overbooking_buffer, stop_sell)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (tenant_id, property_id, room_type_id, date) DO UPDATE SET physical=EXCLUDED.physical, sold=EXCLUDED.sold, blocked=EXCLUDED.blocked, overbooking_buffer=EXCLUDED.overbooking_buffer, stop_sell=EXCLUDED.stop_sell, version=ari_inventory_grid.version+1, updated_at=now()
      RETURNING version`, [t, o.propertyId, o.roomTypeId, o.date, o.physical, o.sold, o.blocked, o.overbookingBuffer, o.stopSell]);
    return Object.assign({}, o, { version: r.rows[0].version });
  }
  async function putRestrictionRule(f) {
    const o = model.makeRestrictionRule(f); const t = f.tenant_id;
    await db.query(`INSERT INTO ari_restriction_rule (tenant_id, id, property_id, level, room_type_id, rate_plan_id, channel, date_from, date_to, dow, cta, ctd, min_los, max_los, stay_through, min_advance_days, max_advance_days, priority)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (tenant_id, id) DO UPDATE SET cta=EXCLUDED.cta, ctd=EXCLUDED.ctd, min_los=EXCLUDED.min_los, max_los=EXCLUDED.max_los, stay_through=EXCLUDED.stay_through, version=ari_restriction_rule.version+1, updated_at=now()`,
      [t, o.id, o.propertyId, o.level, o.roomTypeId, o.ratePlanId, o.channel, o.date_from, o.date_to, o.dow, o.cta, o.ctd, o.minLos, o.maxLos, o.stayThrough, o.minAdvanceDays, o.maxAdvanceDays, o.priority]);
    return o;
  }

  /** Optimistic update: apply `patch` only if the row's version is `expectedVersion`. */
  async function updateInventoryOptimistic({ tenant_id, propertyId, roomTypeId, date, patch = {}, expectedVersion }) {
    const sets = [];
    const vals = [tenant_id, propertyId, roomTypeId, date, expectedVersion];
    let i = 6;
    for (const col of ['physical', 'sold', 'blocked', 'overbooking_buffer', 'stop_sell']) {
      const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (patch[camel] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(patch[camel]); }
    }
    if (!sets.length) return { conflict: false, updated: 0 };
    const r = await db.query(`UPDATE ari_inventory_grid SET ${sets.join(', ')}, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND property_id=$2 AND room_type_id=$3 AND date=$4 AND version=$5 RETURNING version`, vals);
    return r.rows[0] ? { conflict: false, updated: 1, version: r.rows[0].version } : { conflict: true, updated: 0 };
  }

  /** Atomic delta on sold (no read-modify-write race). Returns the new row. */
  async function adjustSold({ tenant_id, propertyId, roomTypeId, date, delta }) {
    const r = await db.query(`UPDATE ari_inventory_grid SET sold = sold + $5, version=version+1, updated_at=now()
      WHERE tenant_id=$1 AND property_id=$2 AND room_type_id=$3 AND date=$4 AND sold + $5 >= 0 RETURNING sold, version`,
      [tenant_id, propertyId, roomTypeId, date, delta]);
    return r.rows[0] || null;
  }

  return {
    roomTypes, ratePlans, inventory, rateRules, restrictionRules, losPricing, mappings,
    putRoomType, putRatePlan, putInventoryCell, putRestrictionRule,
    updateInventoryOptimistic, adjustSold
  };
}

// node-pg returns DATE columns as a JS Date at LOCAL midnight; format with LOCAL
// components (NOT toISOString, which would shift the day in non-UTC timezones).
function iso(d) {
  if (d instanceof Date) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return String(d).slice(0, 10);
}

module.exports = { buildDbAriStore };
