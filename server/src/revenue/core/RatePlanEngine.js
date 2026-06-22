'use strict';

/**
 * RatePlanEngine - pricing structure per (property, room type): base rate,
 * floor/cap, rule sets, seasonal config, event dates, blackout periods, and the
 * stability knobs (smoothing factor, max daily change).
 */

function buildRatePlanEngine({ repo } = {}) {
  if (!repo) throw new Error('RatePlanEngine: repo required');
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };

  return {
    async setRatePlan(ctx, { roomTypeId, baseRate, minRate, maxRate, rules, seasonalConfig, eventDates, blackoutDates, smoothingFactor, maxDailyChangePct } = {}) {
      const propertyId = requireProperty(ctx);
      if (!roomTypeId) throw new Error('roomTypeId required');
      if (!(Number(baseRate) > 0)) throw new Error('baseRate must be > 0');
      const base = Number(baseRate);
      const plan = {
        propertyId, roomTypeId,
        baseRate: base,
        minRate: minRate != null ? Number(minRate) : Math.round(base * 0.5 * 100) / 100,
        maxRate: maxRate != null ? Number(maxRate) : Math.round(base * 2 * 100) / 100,
        rules: rules || [],
        seasonalConfig: seasonalConfig || {},
        eventDates: eventDates || [],
        blackoutDates: blackoutDates || [],
        smoothingFactor: smoothingFactor != null ? Number(smoothingFactor) : 0.5,
        maxDailyChangePct: maxDailyChangePct != null ? Number(maxDailyChangePct) : 0.2
      };
      return repo.saveRatePlan(plan);
    },
    async getRatePlan(ctx, roomTypeId) { return repo.getRatePlan(requireProperty(ctx), roomTypeId); },
    isBlackout(plan, date) { return !!(plan.blackoutDates && plan.blackoutDates.includes(date)); },
    isEvent(plan, date) { return !!(plan.eventDates && plan.eventDates.includes(date)); }
  };
}

module.exports = { buildRatePlanEngine };
