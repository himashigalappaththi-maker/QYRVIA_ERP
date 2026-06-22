'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands } = require('../src/commands/pms');
const { makeQueries  } = require('../src/queries/pms');
const availability = require('../src/services/pms/availability');

const CTX = {
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
};

async function build() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  makeCommands({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeQueries ({ pmsRepo: repos.pmsRepo }).forEach((q) => queryBus.register(q));
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'A' }, CTX);
  const rt    = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, CTX);
  // create 3 rooms
  for (const n of ['101','102','103']) {
    await commandBus.dispatch('pms.room.create', { room_number: n, room_type_id: rt.result.id }, CTX);
  }
  return { repos, adultId: adult.result.id, roomTypeId: rt.result.id };
}

test('availability.byDate: 3 rooms, 0 occupied -> 3 available', async () => {
  await build();
  const r = await queryBus.execute('pms.availability.byDate', { date: '2026-08-01' }, CTX);
  assert.equal(r.ok, true);
  const byType = Object.values(r.data)[0];
  assert.equal(byType.total, 3);
  assert.equal(byType.occupied, 0);
  assert.equal(byType.available, 3);
});

test('availability.byDate: confirmed reservation reduces inventory', async () => {
  const { adultId, roomTypeId } = await build();
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-08-01', departure_date: '2026-08-03',
    rooms_count: 1
  }, CTX);
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: r.result.id }, CTX);
  const av = await queryBus.execute('pms.availability.byDate', { date: '2026-08-01' }, CTX);
  const byType = Object.values(av.data)[0];
  assert.equal(byType.occupied, 1);
  assert.equal(byType.available, 2);
});

test('availability.byDate: cancelled reservation restores inventory', async () => {
  const { adultId, roomTypeId } = await build();
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-08-01', departure_date: '2026-08-03'
  }, CTX);
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: r.result.id }, CTX);
  await commandBus.dispatch('pms.reservation.cancel',  { reservation_id: r.result.id, reason: 'x' }, CTX);
  const av = await queryBus.execute('pms.availability.byDate', { date: '2026-08-01' }, CTX);
  assert.equal(Object.values(av.data)[0].available, 3);
});

test('availability.byDate: departure day is NOT occupied (checkout)', async () => {
  const { adultId, roomTypeId } = await build();
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-08-01', departure_date: '2026-08-03'
  }, CTX);
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: r.result.id }, CTX);
  // on 2026-08-03 (departure), the room is free
  const av = await queryBus.execute('pms.availability.byDate', { date: '2026-08-03' }, CTX);
  assert.equal(Object.values(av.data)[0].available, 3);
});

test('availability.calendar produces a per-day matrix', async () => {
  const { adultId, roomTypeId } = await build();
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-09-01', departure_date: '2026-09-03'
  }, CTX);
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: r.result.id }, CTX);
  const cal = await queryBus.execute('pms.availability.calendar', { date_from: '2026-09-01', date_to: '2026-09-05' }, CTX);
  assert.equal(cal.data.days.length, 4); // 09-01..09-04
  assert.equal(cal.data.days[0].roomTypes.STD.sold, 1);
  assert.equal(cal.data.days[1].roomTypes.STD.sold, 1);
  assert.equal(cal.data.days[2].roomTypes.STD.sold, 0); // departure 09-03 -> free
});

test('availability.calendar rejects > 1y span', async () => {
  await build();
  const cal = await queryBus.execute('pms.availability.calendar', { date_from: '2026-01-01', date_to: '2028-01-01' }, CTX);
  assert.equal(cal.ok, false);
});

// ----- rate plan -----------------------------------------------------------

test('rateplan.create + byId returns periods + pricing', async () => {
  const { repos } = await build();
  void repos;
  const r = await commandBus.dispatch('pms.rateplan.create', {
    code: 'BAR', name: 'Best Available Rate', currency: 'LKR', base_rate: 12000,
    periods: [{ name: 'Christmas', date_from: '2026-12-20', date_to: '2027-01-05', rate: 25000 }],
    pricing: [{ pricing_type: 'OCCUPANCY', occupancy_count: 1, rate: 9000 }]
  }, CTX);
  assert.equal(r.ok, true);
  const det = await queryBus.execute('pms.rateplan.byId', { id: r.result.id }, CTX);
  assert.equal(det.ok, true);
  assert.equal(det.data.code, 'BAR');
  assert.equal(det.data.periods.length, 1);
  assert.equal(det.data.pricing.length, 1);
});

test('rateplan.create rejects missing code', async () => {
  await build();
  const r = await commandBus.dispatch('pms.rateplan.create', { name: 'X' }, CTX);
  assert.equal(r.ok, false);
});
