'use strict';

/**
 * ARI service (Phase 30.1) - orchestrates the availability / rate / restriction
 * engines over a property's state (from an injected store) and emits the
 * standardized ARI output contract. Deterministic: state in -> identical output.
 *
 * Store contract (each returns an array of model objects, scoped to the property;
 * may be sync or return a Promise - both are awaited):
 *   roomTypes(propertyId), ratePlans(propertyId), inventory(propertyId, from, to),
 *   rateRules(propertyId), losPricing(propertyId), restrictionRules(propertyId),
 *   mappings(propertyId)
 *
 * Multi-property isolation: every read is by propertyId; the service never mixes
 * properties. The DB store additionally enforces tenant RLS.
 */

const availability = require('./availabilityEngine');
const { quoteNight } = require('./rateEngine');
const { restrictionsForDate } = require('./restrictionEngine');
const { evaluateStay } = require('./restrictionEngine');
const { buildMappingIndex } = require('./mapping');
const { ARI_VERSION, restrictionShape } = require('./outputContract');

function datesInRange(dateFrom, dateTo) {
  const out = [];
  for (let d = dateFrom; d < dateTo; d = availability.nextDate(d)) out.push(d);
  return out;
}
const byId = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);

function buildAriService({ store } = {}) {
  if (!store) throw new Error('ariService: store required');
  const get = (fn, ...a) => Promise.resolve(typeof store[fn] === 'function' ? store[fn](...a) : []);

  /**
   * Compute the ARI grid for a property + optional channel over [dateFrom, dateTo).
   * query: { propertyId, channel?, dateFrom, dateTo, adults?, childrenAges? }
   */
  async function computeAri(query = {}) {
    const { propertyId, channel = null, dateFrom, dateTo } = query;
    if (!propertyId) throw new Error('ariService: propertyId required');
    if (!dateFrom || !dateTo || dateTo <= dateFrom) throw new Error('ariService: valid dateFrom/dateTo required');

    const [roomTypes, ratePlans, inv, rateRules, losPricing, restrictionRules, mappings] = await Promise.all([
      get('roomTypes', propertyId), get('ratePlans', propertyId), get('inventory', propertyId, dateFrom, dateTo),
      get('rateRules', propertyId), get('losPricing', propertyId), get('restrictionRules', propertyId), get('mappings', propertyId)
    ]);

    const map = buildMappingIndex(mappings);
    const dates = datesInRange(dateFrom, dateTo);
    const cellsByKey = new Map();
    for (const c of inv) cellsByKey.set(c.roomTypeId + '|' + c.date, c);
    const currencyFallback = (ratePlans[0] && ratePlans[0].currency) || 'LKR';

    const room_types = [...roomTypes].sort(byId('roomTypeId')).map((rt) => {
      const avail = dates.map((date) => {
        const a = availability.availability(cellsByKey.get(rt.roomTypeId + '|' + date));
        return { date, available: a.available, stop_sell: a.stopSell };
      });

      const plans = ratePlans
        .filter((rp) => rp.roomTypeId === rt.roomTypeId && map.isExposed(channel, rt.roomTypeId, rp.ratePlanId))
        .sort(byId('ratePlanId'))
        .map((rp) => {
          const days = dates.map((date) => {
            const ctx = { propertyId, roomTypeId: rt.roomTypeId, ratePlanId: rp.ratePlanId, channel, date };
            const q = quoteNight(rp, ctx, { adults: query.adults, childrenAges: query.childrenAges, los: null, rateRules, losPricing });
            const r = restrictionsForDate(restrictionRules, ctx);
            return { date, rate: q.rate, currency: rp.currency, restrictions: restrictionShape(r) };
          });
          return { rate_plan_id: rp.ratePlanId, code: rp.code, currency: rp.currency, days };
        });

      return { room_type_id: rt.roomTypeId, code: rt.code, availability: avail, rate_plans: plans };
    });

    return { ari_version: ARI_VERSION, property_id: propertyId, channel, currency: currencyFallback, date_from: dateFrom, date_to: dateTo, room_types };
  }

  /**
   * Quote one concrete stay (availability + restrictions + total price).
   * query: { propertyId, channel?, roomTypeId, ratePlanId, arrival, departure, adults?, childrenAges?, bookingDate? }
   */
  async function quoteStay(query = {}) {
    const { propertyId, channel = null, roomTypeId, ratePlanId, arrival, departure } = query;
    if (!propertyId || !roomTypeId || !ratePlanId || !arrival || !departure) throw new Error('ariService: stay query requires propertyId, roomTypeId, ratePlanId, arrival, departure');

    const [ratePlans, inv, rateRules, losPricing, restrictionRules] = await Promise.all([
      get('ratePlans', propertyId), get('inventory', propertyId, arrival, departure),
      get('rateRules', propertyId), get('losPricing', propertyId), get('restrictionRules', propertyId)
    ]);
    const rp = ratePlans.find((p) => p.ratePlanId === ratePlanId && p.roomTypeId === roomTypeId);
    if (!rp) return { bookable: false, reasons: ['rate_plan_not_found'] };

    const cellsByDate = {};
    for (const c of inv) if (c.roomTypeId === roomTypeId) cellsByDate[c.date] = c;
    const avail = availability.stayAvailability(cellsByDate, arrival, departure);

    const restriction = evaluateStay(restrictionRules, { propertyId, roomTypeId, ratePlanId, channel, arrival, departure, bookingDate: query.bookingDate });
    const dates = datesInRange(arrival, departure);
    const nights = dates.map((date) => quoteNight(rp, { propertyId, roomTypeId, ratePlanId, channel, date },
      { adults: query.adults, childrenAges: query.childrenAges, los: restriction.los, rateRules, losPricing }));
    const total = Math.round((nights.reduce((s, n) => s + n.rate, 0) + Number.EPSILON) * 100) / 100;

    return {
      bookable: restriction.bookable && avail > 0,
      available: avail,
      los: restriction.los,
      reasons: avail > 0 ? restriction.reasons : restriction.reasons.concat(avail <= 0 ? ['no_availability'] : []),
      currency: rp.currency,
      total,
      nights
    };
  }

  return { computeAri, quoteStay };
}

module.exports = { buildAriService };
