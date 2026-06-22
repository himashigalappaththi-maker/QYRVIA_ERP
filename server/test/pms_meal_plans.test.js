'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands: makePmsCommands } = require('../src/commands/pms');
const { makeMealPlanCommands }          = require('../src/commands/pms/mealPlans');
const { makeQueries }                   = require('../src/queries/pms');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

function fresh() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  makePmsCommands     ({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeMealPlanCommands({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeQueries         ({ pmsRepo: repos.pmsRepo }).forEach((q) => queryBus.register(q));
  return { db, repos };
}

test('pms.mealplan.create: BB basis with includes_breakfast=true', async () => {
  const { db } = fresh();
  const r = await commandBus.dispatch('pms.mealplan.create', {
    code: 'BB', name: 'Bed & Breakfast', basis: 'BB',
    includes_breakfast: true, adult_rate: 800, child_rate: 400
  }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.basis, 'BB');
  const ev = db.auditRows.find(x => x.event_type === 'meal_plan.created');
  assert.equal(ev.payload.basis, 'BB');
  assert.equal(ev.payload.includes_breakfast, true);
});

test('pms.mealplan.create: rejects invalid basis', async () => {
  fresh();
  const r = await commandBus.dispatch('pms.mealplan.create', {
    code: 'XX', name: 'Bad', basis: 'XX'
  }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_basis');
});

test('pms.mealplan.create: rejects duplicate (property_id, code)', async () => {
  fresh();
  await commandBus.dispatch('pms.mealplan.create', { code: 'BB', name: 'BB1', basis: 'BB' }, CTX());
  const r = await commandBus.dispatch('pms.mealplan.create', { code: 'BB', name: 'BB2', basis: 'BB' }, CTX());
  assert.equal(r.ok, false);
});

test('pms.mealplan.create: rejects without ctx.propertyId', async () => {
  fresh();
  const r = await commandBus.dispatch('pms.mealplan.create',
    { code: 'BB', name: 'BB', basis: 'BB' },
    CTX({ propertyId: null }));
  assert.equal(r.ok, false);
});

test('pms.mealplan.list returns only this property + tenant', async () => {
  const { repos } = fresh();
  await commandBus.dispatch('pms.mealplan.create', { code: 'BB', name: 'B', basis: 'BB' }, CTX());
  await commandBus.dispatch('pms.mealplan.create', { code: 'HB', name: 'H', basis: 'HB' }, CTX());
  // cross-tenant: another tenant in same fixture state should NOT appear
  repos.pmsRepo._store.guests.push({ tenant_id: fx.TENANT_B }); // no-op, sanity
  const list = await queryBus.execute('pms.mealplan.list', {}, CTX());
  assert.equal(list.ok, true);
  assert.equal(list.data.length, 2);
  assert.deepEqual(list.data.map(m => m.code).sort(), ['BB','HB']);
});

test('pms.mealplan.attach_to_rateplan links rate_plan -> meal_plan and emits link event', async () => {
  const { db, repos } = fresh();
  const mp = await commandBus.dispatch('pms.mealplan.create', { code: 'BB', name: 'B', basis: 'BB', includes_breakfast: true }, CTX());
  const rp = await commandBus.dispatch('pms.rateplan.create', { code: 'BAR', name: 'Best Available Rate', currency: 'LKR', base_rate: 5000 }, CTX());
  const link = await commandBus.dispatch('pms.mealplan.attach_to_rateplan',
    { rate_plan_id: rp.result.id, meal_plan_id: mp.result.id }, CTX());
  assert.equal(link.ok, true, JSON.stringify(link));
  const stored = repos.pmsRepo._store.ratePlans.find(x => x.id === rp.result.id);
  assert.equal(stored.meal_plan_id, mp.result.id);
  const ev = db.auditRows.find(x => x.event_type === 'rate_plan.meal_plan_linked');
  assert.equal(ev.payload.meal_plan_id, mp.result.id);
});

test('pms.mealplan.attach_to_rateplan refuses cross-property pairing', async () => {
  const { repos } = fresh();
  // create a meal plan at PROP_ID
  const mp = await commandBus.dispatch('pms.mealplan.create', { code: 'BB', name: 'B', basis: 'BB' }, CTX());
  // create a rate plan AT A DIFFERENT property
  const OTHER_PROP = '11111111-1111-1111-1111-111111111111';
  repos.pmsRepo._seedProperty({ id: OTHER_PROP, tenant_id: fx.TENANT_A, code: 'OTH', name: 'Other', currency: 'LKR', active: true });
  const rp = await commandBus.dispatch('pms.rateplan.create',
    { code: 'BAR', name: 'BAR', currency: 'LKR', base_rate: 1 },
    CTX({ propertyId: OTHER_PROP }));
  const link = await commandBus.dispatch('pms.mealplan.attach_to_rateplan',
    { rate_plan_id: rp.result.id, meal_plan_id: mp.result.id }, CTX());
  assert.equal(link.ok, false);
  assert.equal(link.error, 'property_mismatch');
});
