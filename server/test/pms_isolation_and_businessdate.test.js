'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands } = require('../src/commands/pms');
const { makeQueries  } = require('../src/queries/pms');

function ctxFor(tenantId, propertyId, businessDate) {
  return {
    requestId: 'rq', tenantId, propertyId, businessDate: businessDate || null,
    actorId: fx.USER_ID, actorName: 'Jane',
    roleCodes: ['super_admin'], roleIds: [], permissions: []
  };
}

async function setupTwoTenants() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  // Property in tenant A and a different one in tenant B
  const propA = fx.PROP_ID;
  const propB = '99999999-9999-1999-9999-999999999999';
  repos.pmsRepo._seedProperty({ id: propA, tenant_id: fx.TENANT_A, code: 'AAA', name: 'A', currency: 'LKR', active: true });
  repos.pmsRepo._seedProperty({ id: propB, tenant_id: fx.TENANT_B, code: 'BBB', name: 'B', currency: 'USD', active: true });
  makeCommands({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeQueries ({ pmsRepo: repos.pmsRepo }).forEach((q) => queryBus.register(q));
  return { repos, propA, propB };
}

test('property isolation: tenant B cannot read tenant A rooms', async () => {
  const { propA, propB } = await setupTwoTenants();
  const ctxA = ctxFor(fx.TENANT_A, propA);
  const ctxB = ctxFor(fx.TENANT_B, propB);
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, ctxA);
  await commandBus.dispatch('pms.room.create', { room_number: '101', room_type_id: rt.result.id }, ctxA);
  const listA = await queryBus.execute('pms.room.list', {}, ctxA);
  const listB = await queryBus.execute('pms.room.list', {}, ctxB);
  assert.equal(listA.data.length, 1);
  assert.equal(listB.data.length, 0);
});

test('property isolation: room.create with another tenant\'s room_type_id is rejected', async () => {
  const { propA, propB } = await setupTwoTenants();
  const ctxA = ctxFor(fx.TENANT_A, propA);
  const ctxB = ctxFor(fx.TENANT_B, propB);
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, ctxA);
  // tenant B tries to use tenant A's room_type_id
  const r = await commandBus.dispatch('pms.room.create', { room_number: '999', room_type_id: rt.result.id }, ctxB);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'room_type_not_found');
});

test('property isolation: reservation list excludes other tenant\'s reservations', async () => {
  const { propA, propB } = await setupTwoTenants();
  const ctxA = ctxFor(fx.TENANT_A, propA);
  const ctxB = ctxFor(fx.TENANT_B, propB);
  const gA = await commandBus.dispatch('pms.guest.create', { first_name: 'A' }, ctxA);
  const gB = await commandBus.dispatch('pms.guest.create', { first_name: 'B' }, ctxB);
  const rtA = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, ctxA);
  const rtB = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, ctxB);
  await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: gA.result.id, primary_adult_guest_id: gA.result.id,
    room_type_id: rtA.result.id, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, ctxA);
  await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: gB.result.id, primary_adult_guest_id: gB.result.id,
    room_type_id: rtB.result.id, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, ctxB);
  const listA = await queryBus.execute('pms.reservation.list', {}, ctxA);
  const listB = await queryBus.execute('pms.reservation.list', {}, ctxB);
  assert.equal(listA.data.length, 1);
  assert.equal(listB.data.length, 1);
  assert.notEqual(listA.data[0].id, listB.data[0].id);
});

test('reservation_number unique per property+year even with parallel tenants', async () => {
  const { propA, propB, repos } = await setupTwoTenants();
  const a = await repos.pmsRepo.bumpReservationCounter({ tenantId: fx.TENANT_A, propertyId: propA, year: 2026 });
  const b = await repos.pmsRepo.bumpReservationCounter({ tenantId: fx.TENANT_B, propertyId: propB, year: 2026 });
  const a2= await repos.pmsRepo.bumpReservationCounter({ tenantId: fx.TENANT_A, propertyId: propA, year: 2026 });
  assert.equal(a, 1);
  assert.equal(b, 1);  // each property+year has its own sequence
  assert.equal(a2, 2);
});

test('business_date integration: when ctx.businessDate present, reservation stores it', async () => {
  const { propA, repos } = await setupTwoTenants();
  const ctx = ctxFor(fx.TENANT_A, propA, '2026-06-15');
  const g  = await commandBus.dispatch('pms.guest.create', { first_name: 'X' }, ctx);
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, ctx);
  await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: g.result.id, primary_adult_guest_id: g.result.id,
    room_type_id: rt.result.id, arrival_date: '2026-06-20', departure_date: '2026-06-21'
  }, ctx);
  const stored = repos.pmsRepo._store.reservations[0];
  assert.equal(stored.business_date, '2026-06-15');
});

test('business_date integration: missing businessDate does NOT block writes (Phase 5 rule)', async () => {
  const { propA } = await setupTwoTenants();
  const ctx = ctxFor(fx.TENANT_A, propA, null);
  const g  = await commandBus.dispatch('pms.guest.create', { first_name: 'X' }, ctx);
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, ctx);
  const r  = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: g.result.id, primary_adult_guest_id: g.result.id,
    room_type_id: rt.result.id, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, ctx);
  assert.equal(r.ok, true);
});
