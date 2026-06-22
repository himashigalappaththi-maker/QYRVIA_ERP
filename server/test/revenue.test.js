'use strict';

/** Phase 17 - Revenue Management Engine (deterministic dynamic pricing). */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryRevenueRepo } = require('../src/revenue/repository/revenueRepo.memory');
const { buildRevenueEngine } = require('../src/revenue/core/RevenueEngine');
const { buildRevenueSubscriber } = require('../src/revenue/services/revenueSubscriber');
const seasonality = require('../src/revenue/core/SeasonalityEngine');
const rules = require('../src/revenue/core/PricingRuleEngine');
const optimizer = require('../src/revenue/core/RateOptimizationEngine');

const CTX = (propertyId, userId = 'rm-1') => ({ tenantId: 't1', propertyId, requestId: 'rq', userId });

function fresh() {
  const repo = buildMemoryRevenueRepo();
  const revenue = buildRevenueEngine({ repo });
  return { repo, revenue };
}

async function plan(revenue, ctx, over = {}) {
  return revenue.setRatePlan(ctx, Object.assign({ roomTypeId: 'STD', baseRate: 100, minRate: 60, maxRate: 200 }, over));
}

test('SeasonalityEngine: deterministic, clamped multiplier', () => {
  assert.equal(seasonality.seasonalMultiplier('2026-07-01', {}), 1.0);
  const m = seasonality.seasonalMultiplier('2026-07-04', { monthFactors: { 7: 1.2 }, holidays: { '2026-07-04': 1.5 } });
  assert.equal(m, 1.8);   // 1.2 * 1.5
  assert.equal(seasonality.seasonalMultiplier('2026-07-04', { holidays: { '2026-07-04': 5 } }), 2.0); // clamped
});

test('PricingRuleEngine: rule enforcement + breakdown', () => {
  const r = rules.evaluate({ rules: [
    { type: 'OCCUPANCY_THRESHOLD', threshold: 0.8, factor: 1.2 },
    { type: 'LENGTH_OF_STAY', minNights: 5, factor: 0.9 }
  ], context: { occupancyPressure: 0.9, lengthOfStay: 6 } });
  assert.equal(r.multiplier, 1.08);   // 1.2 * 0.9
  assert.equal(r.impacts.length, 2);
});

test('RateOptimizationEngine: clamps to floor/cap and smooths (no jump)', () => {
  const high = optimizer.computeRate({ baseRate: 100, demandMultiplier: 5, minRate: 60, maxRate: 200 });
  assert.equal(high.finalRate, 200);   // clamped to cap
  // smoothing + 20% daily cap from a previous rate
  const smoothed = optimizer.computeRate({ baseRate: 100, demandMultiplier: 5, minRate: 60, maxRate: 500, previousRate: 100, maxDailyChangePct: 0.2 });
  assert.ok(smoothed.finalRate <= 120, 'no more than +20% per day; got ' + smoothed.finalRate);
});

test('getRate produces an immutable DynamicRateSnapshot with breakdown', async () => {
  const { revenue } = fresh();
  const ctx = CTX('PA');
  await revenue.setCapacity(ctx, 10);
  await plan(revenue, ctx);
  const snap = await revenue.getRate(ctx, { roomTypeId: 'STD', date: '2026-07-01' });
  assert.ok(snap.computedRate >= 60 && snap.computedRate <= 200);
  assert.ok('demandScore' in snap && 'seasonalMultiplier' in snap && 'ruleImpact' in snap && 'confidenceScore' in snap);
  assert.ok(Object.isFrozen(snap));
  assert.throws(() => { snap.computedRate = 1; });
});

test('higher demand yields a higher rate (deterministic)', async () => {
  const { revenue, repo } = fresh();
  const ctx = CTX('PA');
  await revenue.setCapacity(ctx, 10);
  await plan(revenue, ctx);
  const low = await revenue.getRate(ctx, { roomTypeId: 'STD', date: '2026-07-01' });
  // drive demand up: many reservations + check-ins
  for (let i = 0; i < 10; i++) { await revenue.demand.reservationCreated(ctx); await revenue.demand.checkIn(ctx); }
  const high = await revenue.getRate(ctx, { roomTypeId: 'STD', date: '2026-07-01' });
  assert.ok(high.demandScore > low.demandScore);
  assert.ok(high.computedRate >= low.computedRate);
});

test('generateRateGrid is stable (no oscillation, bounded day-over-day change)', async () => {
  const { revenue } = fresh();
  const ctx = CTX('PA');
  await revenue.setCapacity(ctx, 10);
  await plan(revenue, ctx, { seasonalConfig: { holidays: { '2026-07-03': 2 } }, maxDailyChangePct: 0.2 });
  const grid = await revenue.generateRateGrid(ctx, { roomTypeId: 'STD', dateFrom: '2026-07-01', dateTo: '2026-07-05' });
  assert.equal(grid.length, 5);
  for (let i = 1; i < grid.length; i++) {
    const change = Math.abs(grid[i].computedRate - grid[i - 1].computedRate) / grid[i - 1].computedRate;
    assert.ok(change <= 0.2001, 'day-over-day change <= 20%: ' + change);
  }
});

test('confirmed/locked reservation is never re-priced', async () => {
  const { revenue } = fresh();
  const ctx = CTX('PA');
  await revenue.setCapacity(ctx, 10);
  await plan(revenue, ctx);
  await revenue.lockReservationRate(ctx, { reservationId: 'R1', rate: 111 });
  for (let i = 0; i < 10; i++) { await revenue.demand.reservationCreated(ctx); await revenue.demand.checkIn(ctx); }
  const snap = await revenue.getRate(ctx, { roomTypeId: 'STD', date: '2026-07-01', reservationId: 'R1' });
  assert.equal(snap.computedRate, 111);
  assert.equal(snap.locked, true);
});

test('manual override is honored and audited', async () => {
  const { revenue } = fresh();
  const ctx = CTX('PA', 'manager-9');
  await plan(revenue, ctx);
  const ov = await revenue.applyManualOverride(ctx, { roomTypeId: 'STD', date: '2026-07-01', rate: 175, reason: 'conference' });
  assert.equal(ov.userId, 'manager-9');
  const snap = await revenue.getRate(ctx, { roomTypeId: 'STD', date: '2026-07-01' });
  assert.equal(snap.computedRate, 175);
  assert.equal(snap.override, true);
});

test('forecast is deterministic and respects seasonality', async () => {
  const { revenue } = fresh();
  const ctx = CTX('PA');
  await revenue.setCapacity(ctx, 10);
  await revenue.setSeasonality(ctx, { holidays: { '2026-07-02': 1.5 } });
  // seed history so baselines are non-zero
  for (let i = 0; i < 6; i++) { await revenue.demand.reservationCreated(ctx); await revenue.demand.checkIn(ctx); }
  await revenue.demand.recordRevenue(ctx, { amount: 600, rooms: 6 });
  await revenue.rolloverDay(ctx, { businessDate: '2026-06-30' });
  const f1 = await revenue.getForecast(ctx, { dateFrom: '2026-07-01', dateTo: '2026-07-03' });
  const f2 = await revenue.getForecast(ctx, { dateFrom: '2026-07-01', dateTo: '2026-07-03' });
  assert.deepEqual(f1, f2);                       // deterministic
  assert.equal(f1.days.length, 3);
  const d2 = f1.days.find((d) => d.date === '2026-07-02');
  const d1 = f1.days.find((d) => d.date === '2026-07-01');
  assert.ok(d2.projectedADR >= d1.projectedADR);  // holiday lifts ADR
});

test('event-driven: subscriber updates demand from reservation/stay/invoice events', async () => {
  const eventBus = require('../src/core/eventBus');
  eventBus.reset();
  eventBus.init({ db: { auditRows: [], async insertAuditEvent(ev) { this.auditRows.push(ev); } } });
  const revenue = buildRevenueEngine({ repo: buildMemoryRevenueRepo() });
  buildRevenueSubscriber({ eventBus, revenue });
  const ctx = CTX('PA');
  await revenue.setCapacity(ctx, 10);
  const base = { tenant_id: 't1', property_id: 'PA' };

  await eventBus.publish(Object.assign({ event_type: 'reservation.created', event_id: 'e1', payload: {} }, base));
  await eventBus.publish(Object.assign({ event_type: 'stay.started', event_id: 'e2', payload: {} }, base));
  const d = await revenue.demand.compute(ctx);
  assert.ok(d.bookingVelocityIndex > 0 && d.occupancyPressureIndex > 0);

  await eventBus.publish(Object.assign({ event_type: 'invoice.finalized', event_id: 'e3', payload: { total: 250 } }, base));
  const kpis = await revenue.getRevenueKPIs(ctx, {});
  assert.equal(kpis.roomRevenue, 250);
});

test('multi-property isolation', async () => {
  const { revenue } = fresh();
  await revenue.setCapacity(CTX('PA'), 10);
  await plan(revenue, CTX('PA'));
  for (let i = 0; i < 8; i++) { await revenue.demand.reservationCreated(CTX('PA')); await revenue.demand.checkIn(CTX('PA')); }
  const a = await revenue.demand.compute(CTX('PA'));
  const b = await revenue.demand.compute(CTX('PB'));
  assert.ok(a.demandScore > b.demandScore);
  assert.equal(b.occupancyPressureIndex, 0);
  await assert.rejects(() => revenue.getRate(CTX('PB'), { roomTypeId: 'STD', date: '2026-07-01' }), /rate_plan_not_found/);
});
