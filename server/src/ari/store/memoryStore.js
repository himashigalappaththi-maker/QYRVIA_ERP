'use strict';

/**
 * In-memory ARI store (Phase 30.1) - the deterministic, dependency-free backing
 * for the engine (unit tests + isolated runtime). Multi-property isolation: every
 * read filters by propertyId. `put*` validate through the model factories, so only
 * well-formed objects are ever stored. The DB store mirrors this contract with
 * real persistence + optimistic-version concurrency.
 */

const model = require('../model');

function buildMemoryAriStore() {
  const roomTypes = new Map();        // roomTypeId -> RoomType
  const ratePlans = new Map();        // ratePlanId -> RatePlan
  const cells = new Map();            // propertyId|roomTypeId|date -> InventoryCell
  const rateRules = new Map();        // id -> RateRule
  const restrictionRules = new Map(); // id -> RestrictionRule
  const losPricing = new Map();       // ratePlanId|los -> LosPricing
  const mappings = new Map();         // channel|roomTypeId|ratePlanId -> ChannelMapping

  const byProp = (m, pid) => [...m.values()].filter((x) => x.propertyId === pid);

  return {
    // ---- reads (store contract) ----
    roomTypes: (pid) => byProp(roomTypes, pid),
    ratePlans: (pid) => byProp(ratePlans, pid),
    inventory: (pid, from, to) => [...cells.values()].filter((c) => c.propertyId === pid && c.date >= from && c.date < to),
    rateRules: (pid) => byProp(rateRules, pid),
    losPricing: (pid) => byProp(losPricing, pid),
    restrictionRules: (pid) => byProp(restrictionRules, pid),
    mappings: (pid) => byProp(mappings, pid),

    // ---- writes (config api; validate via model) ----
    putRoomType(f) { const o = model.makeRoomType(f); roomTypes.set(o.roomTypeId, o); return o; },
    putRatePlan(f) { const o = model.makeRatePlan(f); ratePlans.set(o.ratePlanId, o); return o; },
    putInventoryCell(f) { const o = model.makeInventoryCell(f); cells.set(o.propertyId + '|' + o.roomTypeId + '|' + o.date, o); return o; },
    putRateRule(f) { const o = model.makeRateRule(f); rateRules.set(o.id, o); return o; },
    putRestrictionRule(f) { const o = model.makeRestrictionRule(f); restrictionRules.set(o.id, o); return o; },
    putLosPricing(f) { const o = model.makeLosPricing(f); losPricing.set(o.ratePlanId + '|' + o.los, o); return o; },
    putMapping(f) { const o = model.makeChannelMapping(f); mappings.set(o.channel + '|' + o.roomTypeId + '|' + o.ratePlanId, o); return o; },
    clear() { for (const m of [roomTypes, ratePlans, cells, rateRules, restrictionRules, losPricing, mappings]) m.clear(); },

    /** Atomic-equivalent delta on sold.
     *  Phase 54 D7c: ceiling guard prevents sold exceeding physical + overbookingBuffer.
     *  Floor guard prevents sold going below 0.
     *  Returns { sold, version } on success; null if either guard fires. */
    adjustSold({ tenant_id, propertyId, roomTypeId, date, delta }) {
      const key = (propertyId || '') + '|' + roomTypeId + '|' + date;
      const record = cells.get(key);
      if (!record) return null;
      const newSold = record.sold + delta;
      if (newSold < 0) return null;
      const ceiling = record.physical + (record.overbookingBuffer || 0);
      if (newSold > ceiling) return null;
      const updated = Object.assign({}, record, { sold: newSold });
      cells.set(key, updated);
      return { sold: newSold, version: null };
    }
  };
}

module.exports = { buildMemoryAriStore };
