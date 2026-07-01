'use strict';

/** Phase 30.1 - ARI Foundation: deterministic availability / rate / restriction engine. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAri, model } = require('../src/ari');
const { availability, stayAvailability } = require('../src/ari/availabilityEngine');
const { quoteNight } = require('../src/ari/rateEngine');
const { restrictionsForDate, evaluateStay } = require('../src/ari/restrictionEngine');
const { resolveField } = require('../src/ari/ruleResolver');
const { validateOutput } = require('../src/ari/outputContract');

const P = 'prop-1';

function seeded() {
  const { service, store } = buildAri();
  store.putRoomType({ propertyId: P, roomTypeId: 'rt-dlx', code: 'DLX', name: 'Deluxe', totalUnits: 5 });
  store.putRatePlan({ propertyId: P, ratePlanId: 'rp-bar', roomTypeId: 'rt-dlx', code: 'BAR', baseRate: 100, standardOccupancy: 2, maxOccupancy: 4, extraAdultAmount: 30, childRates: [{ maxAge: 6, amount: 0 }, { maxAge: 12, amount: 20 }] });
  for (const date of ['2026-07-01', '2026-07-02', '2026-07-03']) {
    store.putInventoryCell({ propertyId: P, roomTypeId: 'rt-dlx', date, physical: 5, sold: 1, blocked: 0 });
  }
  return { service, store };
}

// 1. model validation
test('model rejects malformed input deterministically', () => {
  assert.throws(() => model.makeRoomType({ propertyId: P }), /roomTypeId required/);
  assert.throws(() => model.makeInventoryCell({ propertyId: P, roomTypeId: 'r', date: 'bad' }), /YYYY-MM-DD/);
  assert.throws(() => model.makeRestrictionRule({ id: 'x', propertyId: P, date_from: '2026-07-02', date_to: '2026-07-01' }), /date_to must be after/);
});

// 2. availability: stop-sell, blocks, overbooking guard
test('availability = physical + buffer - sold - blocked, 0 when stop-sell', () => {
  assert.equal(availability(model.makeInventoryCell({ propertyId: P, roomTypeId: 'r', date: '2026-07-01', physical: 5, sold: 2, blocked: 1 })).available, 2);
  assert.equal(availability(model.makeInventoryCell({ propertyId: P, roomTypeId: 'r', date: '2026-07-01', physical: 5, sold: 2, stopSell: true })).available, 0);
  assert.equal(availability(model.makeInventoryCell({ propertyId: P, roomTypeId: 'r', date: '2026-07-01', physical: 5, sold: 2, blocked: 1, overbookingBuffer: 3 })).available, 5);
  assert.equal(availability(null).available, 0);
});

// 3. stay availability = limiting night
test('stay availability is the minimum night across the range', () => {
  const cells = {
    '2026-07-01': model.makeInventoryCell({ propertyId: P, roomTypeId: 'r', date: '2026-07-01', physical: 5, sold: 1 }),
    '2026-07-02': model.makeInventoryCell({ propertyId: P, roomTypeId: 'r', date: '2026-07-02', physical: 5, sold: 4 })
  };
  assert.equal(stayAvailability(cells, '2026-07-01', '2026-07-03'), 1);
});

// 4. rate engine: occupancy + extra adult + children
test('rate: base, extra-adult, occupancy-rate override, child pricing', () => {
  const rp = model.makeRatePlan({ propertyId: P, ratePlanId: 'rp', roomTypeId: 'rt', code: 'BAR', baseRate: 100, standardOccupancy: 2, maxOccupancy: 4, extraAdultAmount: 30, occupancyRates: { 1: 80 }, childRates: [{ maxAge: 12, amount: 20 }] });
  const ctx = { propertyId: P, roomTypeId: 'rt', ratePlanId: 'rp', channel: null, date: '2026-07-01' };
  assert.equal(quoteNight(rp, ctx, { adults: 2 }).rate, 100);
  assert.equal(quoteNight(rp, ctx, { adults: 3 }).rate, 130);          // +1 extra adult
  assert.equal(quoteNight(rp, ctx, { adults: 1 }).rate, 80);           // occupancyRates[1]
  assert.equal(quoteNight(rp, ctx, { adults: 2, childrenAges: [10] }).rate, 120); // +child
});

// 5. rate engine: seasonal amount + pct + DOW + LOS
test('rate: seasonal amount replaces base; pct multiplies; LOS pricing applies', () => {
  const rp = model.makeRatePlan({ propertyId: P, ratePlanId: 'rp', roomTypeId: 'rt', code: 'BAR', baseRate: 100, standardOccupancy: 2 });
  const ctx = { propertyId: P, roomTypeId: 'rt', ratePlanId: 'rp', channel: null, date: '2026-07-01' };
  const seasonal = [model.makeRateRule({ id: 's1', level: 'property', propertyId: P, date_from: '2026-07-01', date_to: '2026-08-01', amount: 150 })];
  assert.equal(quoteNight(rp, ctx, { adults: 2, rateRules: seasonal }).rate, 150);
  const pct = [model.makeRateRule({ id: 'p1', level: 'channel', propertyId: P, channel: 'BCOM', date_from: '2026-07-01', date_to: '2026-08-01', pct: 120 })];
  assert.equal(quoteNight(rp, Object.assign({}, ctx, { channel: 'BCOM' }), { adults: 2, rateRules: pct }).rate, 120);
  const los = [model.makeLosPricing({ propertyId: P, ratePlanId: 'rp', los: 3, amount: 90 })];
  assert.equal(quoteNight(rp, ctx, { adults: 2, los: 4, losPricing: los }).rate, 90); // los>=3 threshold
});

// 6. rule resolver priority: system < property < rate_plan < channel
test('resolver: channel override beats rate_plan beats property beats system', () => {
  const ctx = { propertyId: P, roomTypeId: 'rt', ratePlanId: 'rp', channel: 'BCOM', date: '2026-07-01' };
  const rules = [
    model.makeRestrictionRule({ id: 'sys', level: 'system', propertyId: P, date_from: '2026-07-01', date_to: '2026-08-01', minLos: 1 }),
    model.makeRestrictionRule({ id: 'prop', level: 'property', propertyId: P, date_from: '2026-07-01', date_to: '2026-08-01', minLos: 2 }),
    model.makeRestrictionRule({ id: 'plan', level: 'rate_plan', propertyId: P, ratePlanId: 'rp', date_from: '2026-07-01', date_to: '2026-08-01', minLos: 3 }),
    model.makeRestrictionRule({ id: 'chan', level: 'channel', propertyId: P, channel: 'BCOM', date_from: '2026-07-01', date_to: '2026-08-01', minLos: 5 })
  ];
  assert.equal(resolveField(rules, ctx, 'minLos', 1), 5);
  assert.equal(resolveField(rules, Object.assign({}, ctx, { channel: null }), 'minLos', 1), 3); // no channel => rate_plan wins
});

// 7. restriction engine: CTA/CTD/minLOS/maxLOS/stay-through/advance window
test('restriction evaluateStay enforces CTA/CTD/LOS/advance', () => {
  const R = (f) => model.makeRestrictionRule(Object.assign({ propertyId: P, date_from: '2026-07-01', date_to: '2026-08-01', level: 'property' }, f));
  const stay = { propertyId: P, roomTypeId: 'rt', ratePlanId: 'rp', channel: null, arrival: '2026-07-01', departure: '2026-07-03' };
  assert.equal(evaluateStay([], stay).bookable, true);
  assert.deepEqual(evaluateStay([R({ id: 'cta', cta: true })], stay).reasons, ['cta']);
  assert.deepEqual(evaluateStay([R({ id: 'minlos', minLos: 3 })], stay).reasons, ['min_los']);
  assert.deepEqual(evaluateStay([R({ id: 'maxlos', maxLos: 1 })], stay).reasons, ['max_los']);
  const adv = evaluateStay([R({ id: 'adv', minAdvanceDays: 10 })], Object.assign({ bookingDate: '2026-06-30' }, stay));
  assert.deepEqual(adv.reasons, ['min_advance']);  // 1 day advance < 10
});

// 8. restrictionsForDate defaults when no rule applies
test('restrictionsForDate yields documented defaults with no rules', () => {
  const r = restrictionsForDate([], { propertyId: P, roomTypeId: 'rt', ratePlanId: 'rp', channel: null, date: '2026-07-01' });
  assert.deepEqual(r, { cta: false, ctd: false, minLos: 1, maxLos: null, stayThrough: false, minAdvanceDays: 0, maxAdvanceDays: null });
});

// 9. service computeAri: well-formed output + determinism
test('computeAri produces a valid, OTA-mappable contract and is deterministic', async () => {
  const { service } = seeded();
  const q = { propertyId: P, dateFrom: '2026-07-01', dateTo: '2026-07-04' };
  const a = await service.computeAri(q);
  const b = await service.computeAri(q);
  assert.equal(validateOutput(a).ok, true);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same input => byte-identical output');
  assert.equal(a.room_types.length, 1);
  assert.equal(a.room_types[0].availability.length, 3);
  assert.equal(a.room_types[0].availability[0].available, 4);  // physical5 - sold1
  assert.equal(a.room_types[0].rate_plans[0].days[0].rate, 100);
});

// 10. quoteStay end-to-end
test('quoteStay returns bookable + total + reasons', async () => {
  const { service, store } = seeded();
  const ok = await service.quoteStay({ propertyId: P, roomTypeId: 'rt-dlx', ratePlanId: 'rp-bar', arrival: '2026-07-01', departure: '2026-07-03', adults: 2 });
  assert.equal(ok.bookable, true);
  assert.equal(ok.total, 200);          // 2 nights x 100
  store.putRestrictionRule({ id: 'cta1', level: 'property', propertyId: P, date_from: '2026-07-01', date_to: '2026-07-02', cta: true });
  const blocked = await service.quoteStay({ propertyId: P, roomTypeId: 'rt-dlx', ratePlanId: 'rp-bar', arrival: '2026-07-01', departure: '2026-07-03', adults: 2 });
  assert.equal(blocked.bookable, false);
  assert.ok(blocked.reasons.includes('cta'));
});

// 11. multi-property isolation
test('computeAri never mixes properties', async () => {
  const { service, store } = seeded();
  store.putRoomType({ propertyId: 'prop-2', roomTypeId: 'rt-x', code: 'X', totalUnits: 3 });
  store.putRatePlan({ propertyId: 'prop-2', ratePlanId: 'rp-x', roomTypeId: 'rt-x', code: 'X', baseRate: 999 });
  const a = await service.computeAri({ propertyId: P, dateFrom: '2026-07-01', dateTo: '2026-07-02' });
  assert.equal(a.room_types.every((rt) => rt.room_type_id === 'rt-dlx'), true);
  assert.equal(JSON.stringify(a).includes('999'), false);
});

// 12. channel exposure via mapping
test('mapping filters rate plans exposed to a channel', async () => {
  const { service, store } = seeded();
  store.putRatePlan({ propertyId: P, ratePlanId: 'rp-nr', roomTypeId: 'rt-dlx', code: 'NR', baseRate: 90, standardOccupancy: 2 });
  // expose only BAR to BCOM
  store.putMapping({ propertyId: P, channel: 'BCOM', roomTypeId: 'rt-dlx', ratePlanId: 'rp-bar', enabled: true });
  const out = await service.computeAri({ propertyId: P, channel: 'BCOM', dateFrom: '2026-07-01', dateTo: '2026-07-02' });
  const planIds = out.room_types[0].rate_plans.map((p) => p.rate_plan_id);
  assert.deepEqual(planIds, ['rp-bar']);  // rp-nr not exposed to BCOM
});
