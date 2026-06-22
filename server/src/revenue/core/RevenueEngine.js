'use strict';

/**
 * RevenueEngine - facade orchestrating demand aggregation, rule application,
 * rate optimization, forecasting and KPI generation into a single deterministic
 * pricing API. No AI. Read-only on upstream phases. Multi-property isolated.
 *
 * Integrity guarantees:
 *   - Confirmed/locked reservations are NEVER re-priced (getRate returns the
 *     locked rate regardless of current demand).
 *   - Rate grids are smoothed across dates (no oscillation / no sudden jumps).
 *   - DynamicRateSnapshots are frozen (immutable).
 */

const { buildDemandEngine } = require('./DemandEngine');
const { buildRatePlanEngine } = require('./RatePlanEngine');
const seasonality = require('./SeasonalityEngine');
const rules = require('./PricingRuleEngine');
const optimizer = require('./RateOptimizationEngine');
const forecastEngine = require('./ForecastEngine');
const revIndex = require('./RevenueIndexEngine');

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function avg(arr) { return arr.length ? arr.reduce((s, n) => s + Number(n), 0) / arr.length : 0; }

function buildRevenueEngine({ repo, clock } = {}) {
  if (!repo) throw new Error('RevenueEngine: repo required');
  const now = clock || (() => Date.now());
  const demand = buildDemandEngine({ repo });
  const ratePlan = buildRatePlanEngine({ repo });
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };

  function snapshot(fields) { return Object.freeze(Object.assign({}, fields)); }

  async function getRate(ctx, { roomTypeId, date, leadTimeDays, lengthOfStay, reservationId, previousRate } = {}) {
    const propertyId = requireProperty(ctx);
    if (!roomTypeId || !date) throw new Error('roomTypeId and date required');

    // Integrity: a locked reservation keeps its original rate, period.
    if (reservationId) {
      const locked = await repo.getLockedRate(propertyId, reservationId);
      if (locked != null) return snapshot({ propertyId, roomTypeId, businessDate: date, computedRate: round2(locked), locked: true, confidenceScore: 1 });
    }

    const plan = await ratePlan.getRatePlan(ctx, roomTypeId);
    if (!plan) throw new Error('rate_plan_not_found');

    const override = await repo.getOverride(propertyId, roomTypeId, date);
    if (override) return snapshot({ propertyId, roomTypeId, businessDate: date, computedRate: round2(override.rate), override: true, reason: override.reason, confidenceScore: 1 });

    if (ratePlan.isBlackout(plan, date)) {
      return snapshot({ propertyId, roomTypeId, businessDate: date, computedRate: round2(plan.maxRate), available: false, blackout: true, confidenceScore: 1 });
    }

    const d = await demand.compute(ctx);
    const seasonalMultiplier = seasonality.seasonalMultiplier(date, plan.seasonalConfig);
    const isEvent = ratePlan.isEvent(plan, date);
    const ruleResult = rules.evaluate({ rules: plan.rules, context: { occupancyPressure: d.occupancyPressureIndex, leadTimeDays, lengthOfStay, isEvent } });
    const opt = optimizer.computeRate({
      baseRate: plan.baseRate, demandMultiplier: d.demandMultiplier, seasonalMultiplier,
      ruleMultiplier: ruleResult.multiplier, minRate: plan.minRate, maxRate: plan.maxRate,
      previousRate, smoothingFactor: plan.smoothingFactor, maxDailyChangePct: plan.maxDailyChangePct
    });

    const history = await repo.listHistory(propertyId);
    const confidenceScore = round2(clamp(0.4 + Math.min(history.length, 5) / 10 + (d.demandScore > 0 ? 0.1 : 0), 0, 1));

    return snapshot({
      propertyId, roomTypeId, businessDate: date, available: true,
      computedRate: opt.finalRate, baseRate: plan.baseRate,
      demandScore: d.demandScore, demandMultiplier: d.demandMultiplier,
      seasonalMultiplier, ruleMultiplier: ruleResult.multiplier, ruleImpact: ruleResult.impacts,
      minRate: plan.minRate, maxRate: plan.maxRate, confidenceScore
    });
  }

  async function generateRateGrid(ctx, { roomTypeId, dateFrom, dateTo } = {}) {
    requireProperty(ctx);
    const grid = [];
    let prev = null;
    for (const date of forecastEngine.dateRange(dateFrom, dateTo)) {
      // eslint-disable-next-line no-await-in-loop
      const snap = await getRate(ctx, { roomTypeId, date, previousRate: prev });
      grid.push(snap);
      if (snap.available !== false) prev = snap.computedRate;   // smoothing chain (skip blackout)
    }
    return Object.freeze(grid);
  }

  async function getForecast(ctx, { dateFrom, dateTo } = {}) {
    const propertyId = requireProperty(ctx);
    const d = await demand.compute(ctx);
    const dem = await repo.getDemand(propertyId);
    const history = await repo.listHistory(propertyId);
    const capacity = Math.max(1, Number(dem.capacity) || 0);
    const baselineOccupancy = history.length ? avg(history.map((h) => h.occupancy))
      : clamp(Math.max(0, dem.checkIns - dem.checkOuts) / capacity, 0, 1);
    const baselineAdr = history.length ? avg(history.map((h) => h.adr))
      : (dem.roomsSold > 0 ? dem.roomRevenue / dem.roomsSold : 0);
    const seasonalityConfig = (await repo.getSeasonality(propertyId)) || {};
    return forecastEngine.forecast({
      dateFrom, dateTo, baselineOccupancy, baselineAdr, capacity,
      seasonalityConfig, paceFactor: clamp(0.5 + d.bookingVelocityIndex, 0.5, 1.5),
      cancellationTrend: d.cancellationPressureIndex
    });
  }

  async function getRevenueKPIs(ctx, { dateFrom, dateTo } = {}) {
    const propertyId = requireProperty(ctx);
    const history = (await repo.listHistory(propertyId))
      .filter((h) => (!dateFrom || h.businessDate >= dateFrom) && (!dateTo || h.businessDate <= dateTo));
    if (history.length === 0) {
      const dem = await repo.getDemand(propertyId);
      return revIndex.kpis({ roomsSold: dem.roomsSold, roomsAvailable: dem.capacity, roomRevenue: dem.roomRevenue });
    }
    const roomsSold = history.reduce((s, h) => s + (h.roomsSold || 0), 0);
    const roomsAvailable = history.reduce((s, h) => s + (h.roomsAvailable || 0), 0);
    const roomRevenue = history.reduce((s, h) => s + (h.revenue || 0), 0);
    return revIndex.kpis({ roomsSold, roomsAvailable, roomRevenue });
  }

  async function getRevenueDashboard(ctx, { dateFrom, dateTo } = {}) {
    const propertyId = requireProperty(ctx);
    const history = await repo.listHistory(propertyId);
    return {
      adrTrend: revIndex.trend(history.map((h) => h.adr)),
      revparTrend: revIndex.trend(history.map((h) => h.adr * h.occupancy)),
      occupancyCurve: history.map((h) => ({ date: h.businessDate, occupancy: h.occupancy })),
      forecast: (dateFrom && dateTo) ? await getForecast(ctx, { dateFrom, dateTo }) : null,
      kpis: await getRevenueKPIs(ctx, { dateFrom, dateTo })
    };
  }

  async function applyManualOverride(ctx, { roomTypeId, date, rate, reason } = {}) {
    const propertyId = requireProperty(ctx);
    if (!roomTypeId || !date || !(Number(rate) > 0)) throw new Error('roomTypeId, date, rate required');
    return repo.setOverride({ propertyId, roomTypeId, date, rate: Number(rate), reason: reason || null,
      userId: (ctx.userId || ctx.actorId) || null, at: new Date(now()).toISOString() });
  }

  async function lockReservationRate(ctx, { reservationId, rate } = {}) {
    const propertyId = requireProperty(ctx);
    if (!reservationId || !(Number(rate) > 0)) throw new Error('reservationId and rate required');
    await repo.lockRate(propertyId, reservationId, Number(rate));
    return { reservationId, rate: round2(rate), locked: true };
  }

  /** Snapshot the day's demand window into history, then reset (on dayend.completed). */
  async function rolloverDay(ctx, { businessDate } = {}) {
    const propertyId = requireProperty(ctx);
    const dem = await repo.getDemand(propertyId);
    const cap = Math.max(1, Number(dem.capacity) || 0);
    const soldOrInhouse = dem.roomsSold || Math.max(0, dem.checkIns - dem.checkOuts);
    const occupancy = round2(clamp(soldOrInhouse / cap, 0, 1));
    const adr = dem.roomsSold > 0 ? round2(dem.roomRevenue / dem.roomsSold) : 0;
    await repo.appendHistory({ propertyId, businessDate: businessDate || null, occupancy, adr,
      revenue: round2(dem.roomRevenue), roomsSold: dem.roomsSold, roomsAvailable: cap });
    await repo.resetDemandWindow(propertyId);
  }

  return {
    demand, ratePlan,
    setRatePlan: (ctx, args) => ratePlan.setRatePlan(ctx, args),
    setCapacity: (ctx, n) => demand.setCapacity(ctx, n),
    setSeasonality: (ctx, cfg) => repo.setSeasonality(requireProperty(ctx), cfg),
    getRate, generateRateGrid, getForecast, getRevenueKPIs, getRevenueDashboard,
    applyManualOverride, lockReservationRate, rolloverDay
  };
}

module.exports = { buildRevenueEngine };
