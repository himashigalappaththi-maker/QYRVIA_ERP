'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands: makePmsCommands }     = require('../src/commands/pms');
const { makeCheckinFolioCommands }          = require('../src/commands/pms/checkinFolio');
const { makeReservationGroupCommands }      = require('../src/commands/pms/reservationGroups');
const { makeQueries }                       = require('../src/queries/pms');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

async function fresh() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  makePmsCommands              ({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeCheckinFolioCommands     ({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo })
    .forEach((c) => commandBus.register(c));
  makeReservationGroupCommands ({ pmsRepo: repos.pmsRepo, commandBus }).forEach((c) => commandBus.register(c));
  makeQueries                  ({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo }).forEach((q) => queryBus.register(q));

  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'A' }, CTX());
  const rt    = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, base_occupancy: 2, extra_bed_capacity: 0 }, CTX());
  return { db, repos, adultId: adult.result.id, roomTypeId: rt.result.id };
}

async function _createReservation(adultId, roomTypeId, ctxOverrides = {}) {
  const r = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-01', departure_date: '2026-07-03',
    adults: 2
  }, CTX(ctxOverrides));
  return r.result.id;
}

test('C5: group create + add 3 rooms + rooming_list returns 3', async () => {
  const { adultId, roomTypeId } = await fresh();
  const grp = await commandBus.dispatch('pms.reservation_group.create',
    { code: 'GRP-A', name: 'Acme Conference', group_type: 'CONFERENCE',
      arrival_date: '2026-07-01', departure_date: '2026-07-03' }, CTX());
  assert.equal(grp.ok, true, JSON.stringify(grp));
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await _createReservation(adultId, roomTypeId));
  for (const id of ids) {
    const r = await commandBus.dispatch('pms.reservation_group.add_room',
      { group_id: grp.result.id, reservation_id: id }, CTX());
    assert.equal(r.ok, true);
  }
  const rl = await queryBus.execute('pms.reservation_group.rooming_list', { id: grp.result.id }, CTX());
  assert.equal(rl.ok, true);
  assert.equal(rl.data.length, 3);
});

test('C5: total_rooms incremented on add_room', async () => {
  const { repos, adultId, roomTypeId } = await fresh();
  const grp = await commandBus.dispatch('pms.reservation_group.create',
    { code: 'GRP-B', name: 'Wedding', group_type: 'WEDDING' }, CTX());
  const r1 = await _createReservation(adultId, roomTypeId);
  await commandBus.dispatch('pms.reservation_group.add_room', { group_id: grp.result.id, reservation_id: r1 }, CTX());
  const stored = repos.pmsRepo._groups.find((g) => g.id === grp.result.id);
  assert.equal(stored.total_rooms, 1);
  assert.equal(stored.total_guests, 2);
});

test('C5: cancel_all cascades cancellation across members + emits group + per-member events', async () => {
  const { db, adultId, roomTypeId } = await fresh();
  const grp = await commandBus.dispatch('pms.reservation_group.create',
    { code: 'GRP-C', name: 'Tour', group_type: 'TOUR_SERIES' }, CTX());
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push(await _createReservation(adultId, roomTypeId));
  for (const id of ids) await commandBus.dispatch('pms.reservation_group.add_room',
    { group_id: grp.result.id, reservation_id: id }, CTX());
  const r = await commandBus.dispatch('pms.reservation_group.cancel_all',
    { group_id: grp.result.id, reason: 'travel_ban' }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.cancelled_count, 2);
  const grpEv = db.auditRows.find(x => x.event_type === 'reservation_group.cancelled');
  assert.equal(grpEv.payload.cancelled_count, 2);
  const memberCancels = db.auditRows.filter(x => x.event_type === 'reservation.cancelled');
  assert.equal(memberCancels.length, 2);
});

test('C5: cancel_all refuses if any member is CHECKED_IN (without force)', async () => {
  const { repos, adultId, roomTypeId } = await fresh();
  const grp = await commandBus.dispatch('pms.reservation_group.create',
    { code: 'GRP-D', name: 'Wedding', group_type: 'WEDDING' }, CTX());
  const r1 = await _createReservation(adultId, roomTypeId);
  const r2 = await _createReservation(adultId, roomTypeId);
  await commandBus.dispatch('pms.reservation_group.add_room', { group_id: grp.result.id, reservation_id: r1 }, CTX());
  await commandBus.dispatch('pms.reservation_group.add_room', { group_id: grp.result.id, reservation_id: r2 }, CTX());
  // Confirm + check-in r1 (need a room)
  const room = await commandBus.dispatch('pms.room.create', { room_type_id: roomTypeId, room_number: '301' }, CTX());
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: r1 }, CTX());
  await commandBus.dispatch('pms.reservation.checkin', { reservation_id: r1, assigned_room_id: room.result.id }, CTX());
  const r = await commandBus.dispatch('pms.reservation_group.cancel_all',
    { group_id: grp.result.id, reason: 'oops' }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'members_checked_in');
});

test('C5: add_room rejects cross-property reservation', async () => {
  const { repos, adultId, roomTypeId } = await fresh();
  const OTHER_PROP = '99999999-9999-9999-9999-999999999999';
  repos.pmsRepo._seedProperty({ id: OTHER_PROP, tenant_id: fx.TENANT_A, code: 'OTH', name: 'O', currency: 'LKR', active: true });
  // create a room type at other property
  const rtOther = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, base_occupancy: 2, extra_bed_capacity: 0 },
    CTX({ propertyId: OTHER_PROP }));
  const adultOther = await commandBus.dispatch('pms.guest.create', { first_name: 'X' }, CTX({ propertyId: OTHER_PROP }));
  const resOther = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultOther.result.id, primary_adult_guest_id: adultOther.result.id,
    room_type_id: rtOther.result.id, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX({ propertyId: OTHER_PROP }));
  // Create a group on PROP_ID
  const grp = await commandBus.dispatch('pms.reservation_group.create',
    { code: 'GRP-E', name: 'X', group_type: 'GROUP' }, CTX());
  const r = await commandBus.dispatch('pms.reservation_group.add_room',
    { group_id: grp.result.id, reservation_id: resOther.result.id }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'property_mismatch');
});

test('C5: rejects invalid group_type', async () => {
  await fresh();
  const r = await commandBus.dispatch('pms.reservation_group.create',
    { code: 'GRP-F', name: 'X', group_type: 'BANANA' }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_group_type');
});
