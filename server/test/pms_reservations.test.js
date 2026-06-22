'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands } = require('../src/commands/pms');
const { makeQueries  } = require('../src/queries/pms');
const { nextReservationNumber } = require('../src/services/pms/reservationNumber');

const CTX = {
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID, businessDate: '2026-06-21',
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
};

async function freshWithGuestsAndType() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  makeCommands({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeQueries ({ pmsRepo: repos.pmsRepo }).forEach((q) => queryBus.register(q));
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'Alice', last_name: 'Adult' }, CTX);
  const rt    = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std', max_adults: 2, max_children: 1, base_occupancy: 2, extra_bed_capacity: 1 }, CTX);
  return { db, repos, adultId: adult.result.id, roomTypeId: rt.result.id };
}

test('reservation number generator: PROPCODE-YYYY-000001 format', async () => {
  const r = await nextReservationNumber({
    async bumpReservationCounter() { return 1; }
  }, { tenantId: 't', propertyId: 'p', propertyCode: 'NEG', year: 2026 });
  assert.equal(r.number, 'NEG-2026-000001');
  assert.equal(r.sequence, 1);
});

test('reservation number is unique per property+year', async () => {
  const { repos } = await freshWithGuestsAndType();
  const a = await repos.pmsRepo.bumpReservationCounter({ tenantId: fx.TENANT_A, propertyId: fx.PROP_ID, year: 2026 });
  const b = await repos.pmsRepo.bumpReservationCounter({ tenantId: fx.TENANT_A, propertyId: fx.PROP_ID, year: 2026 });
  assert.equal(a, 1);
  assert.equal(b, 2);
});

test('reservation.create happy path emits reservation.created with proper number', async () => {
  const { db, adultId, roomTypeId } = await freshWithGuestsAndType();
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    reservation_type: 'INDIVIDUAL',
    room_type_id: roomTypeId,
    arrival_date: '2026-07-01', departure_date: '2026-07-04',
    adults: 2, children: 0
  }, CTX);
  assert.equal(r.ok, true);
  assert.match(r.result.reservation_number, /^NEG-\d{4}-\d{6}$/);
  const ev = db.auditRows.find(x => x.event_type === 'reservation.created');
  assert.equal(ev.payload.adults, 2);
});

test('reservation.create stamps business_date from ctx', async () => {
  const { adultId, roomTypeId, repos } = await freshWithGuestsAndType();
  await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX);
  const stored = repos.pmsRepo._store.reservations[0];
  assert.equal(stored.business_date, '2026-06-21');
});

test('reservation.create rejects blacklisted holder', async () => {
  const f = await freshWithGuestsAndType();
  await commandBus.dispatch('pms.guest.blacklist', { guest_id: f.adultId, blacklisted: true }, CTX);
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: f.adultId, primary_adult_guest_id: f.adultId,
    room_type_id: f.roomTypeId, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'holder_blacklisted');
});

test('reservation.create rejects departure <= arrival', async () => {
  const { adultId, roomTypeId } = await freshWithGuestsAndType();
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-05', departure_date: '2026-07-05'
  }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_date_range');
});

test('reservation.create rejects when child policy supplied + party exceeds capacity', async () => {
  const { adultId, roomTypeId } = await freshWithGuestsAndType();
  const policy = await commandBus.dispatch('pms.childpolicy.create', {
    code: 'CP1', name: 'CP1',
    categories: [{ code: 'CH', name: 'Child', age_from: 0, age_to: 12, counts_in_occupancy: true }]
  }, CTX);
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-10', departure_date: '2026-07-12',
    adults: 2, children: 3,
    child_policy_id: policy.result.id,
    child_ages: [5, 6, 7]
  }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'capacity_exceeded');
});

test('reservation.confirm flips INQUIRY -> CONFIRMED + emits event', async () => {
  const { db, adultId, roomTypeId } = await freshWithGuestsAndType();
  const c = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX);
  const cf = await commandBus.dispatch('pms.reservation.confirm', { reservation_id: c.result.id }, CTX);
  assert.equal(cf.ok, true);
  assert.equal(cf.result.status, 'CONFIRMED');
  assert.ok(db.auditRows.find(x => x.event_type === 'reservation.confirmed'));
});

test('reservation.cancel sets status CANCELLED + emits event with reason', async () => {
  const { db, adultId, roomTypeId } = await freshWithGuestsAndType();
  const c = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX);
  const cn = await commandBus.dispatch('pms.reservation.cancel', { reservation_id: c.result.id, reason: 'guest_request' }, CTX);
  assert.equal(cn.ok, true);
  assert.equal(cn.result.status, 'CANCELLED');
  const ev = db.auditRows.find(x => x.event_type === 'reservation.cancelled');
  assert.equal(ev.payload.reason, 'guest_request');
});

test('reservation.noShow only valid from CONFIRMED', async () => {
  const { adultId, roomTypeId } = await freshWithGuestsAndType();
  const c = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX);
  // Cannot no-show from INQUIRY
  const ns = await commandBus.dispatch('pms.reservation.noShow', { reservation_id: c.result.id }, CTX);
  assert.equal(ns.ok, false);
  assert.equal(ns.error, 'invalid_transition');
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: c.result.id }, CTX);
  const ns2 = await commandBus.dispatch('pms.reservation.noShow', { reservation_id: c.result.id }, CTX);
  assert.equal(ns2.ok, true);
  assert.equal(ns2.result.status, 'NO_SHOW');
});

test('reservation.list + byNumber', async () => {
  const { adultId, roomTypeId } = await freshWithGuestsAndType();
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX);
  const list = await queryBus.execute('pms.reservation.list', {}, CTX);
  assert.equal(list.data.length, 1);
  const byNum = await queryBus.execute('pms.reservation.byNumber', { reservation_number: r.result.reservation_number }, CTX);
  assert.equal(byNum.data.reservation_number, r.result.reservation_number);
});
