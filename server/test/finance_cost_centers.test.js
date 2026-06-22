'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCostCenterCommands } = require('../src/commands/finance/costCenters');
const { makeQueries: makeFinanceQueries } = require('../src/queries/finance');

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
  makeCostCenterCommands({ costCenterRepo: repos.costCenterRepo }).forEach((c) => commandBus.register(c));
  makeFinanceQueries({ costCenterRepo: repos.costCenterRepo }).forEach((q) => queryBus.register(q));
  return { db, repos };
}

test('C11: finance.cost_center.create persists ROOM cost center', async () => {
  const { db } = fresh();
  const r = await commandBus.dispatch('finance.cost_center.create',
    { code: 'CC-ROOM', name: 'Room Revenue', type: 'ROOM' }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.type, 'ROOM');
  const ev = db.auditRows.find(x => x.event_type === 'cost_center.created');
  assert.equal(ev.payload.type, 'ROOM');
});

test('C11: rejects invalid type', async () => {
  fresh();
  const r = await commandBus.dispatch('finance.cost_center.create',
    { code: 'X', name: 'Y', type: 'BANANA' }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_type');
});

test('C11: refuses duplicate (tenant, property, code)', async () => {
  fresh();
  await commandBus.dispatch('finance.cost_center.create',
    { code: 'CC-A', name: 'A', type: 'OTHER' }, CTX());
  const r = await commandBus.dispatch('finance.cost_center.create',
    { code: 'CC-A', name: 'A2', type: 'OTHER' }, CTX());
  assert.equal(r.ok, false);
});

test('C11: finance.cost_center.disable transitions is_active=false + emits event', async () => {
  const { db } = fresh();
  const c = await commandBus.dispatch('finance.cost_center.create',
    { code: 'CC-D', name: 'D', type: 'ADMIN' }, CTX());
  const d = await commandBus.dispatch('finance.cost_center.disable', { id: c.result.id }, CTX());
  assert.equal(d.ok, true);
  assert.equal(d.result.is_active, false);
  const ev = db.auditRows.find(x => x.event_type === 'cost_center.disabled');
  assert.ok(ev);
});

test('C11: finance.cost_center.list scoped to property', async () => {
  const { repos } = fresh();
  await commandBus.dispatch('finance.cost_center.create',
    { code: 'CC-1', name: '1', type: 'ROOM' }, CTX());
  // Different property
  const OTHER = '99999999-9999-9999-9999-999999999999';
  await commandBus.dispatch('finance.cost_center.create',
    { code: 'CC-OTHER', name: 'Z', type: 'ROOM' }, CTX({ propertyId: OTHER }));
  const r = await queryBus.execute('finance.cost_center.list', {}, CTX());
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].code, 'CC-1');
});
