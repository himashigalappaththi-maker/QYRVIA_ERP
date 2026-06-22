'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands: makePmsCommands } = require('../src/commands/pms');
const { makeQueries  } = require('../src/queries/pms');
const { makeCheckinFolioCommands } = require('../src/commands/pms/checkinFolio');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-21', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

async function freshSetup() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  makePmsCommands({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeQueries  ({ pmsRepo: repos.pmsRepo }).forEach((q) => queryBus.register(q));
  makeCheckinFolioCommands({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo,
                              housekeepingRepo: repos.housekeepingRepo })
    .forEach((c) => commandBus.register(c));
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'Bob', last_name: 'Holder' }, CTX());
  const rt    = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, max_children: 0, base_occupancy: 2, extra_bed_capacity: 0 }, CTX());
  const room  = await commandBus.dispatch('pms.room.create',
    { room_type_id: rt.result.id, room_number: '101' }, CTX());
  const res   = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adult.result.id, primary_adult_guest_id: adult.result.id,
    room_type_id: rt.result.id,
    arrival_date: '2026-07-01', departure_date: '2026-07-03'
  }, CTX());
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: res.result.id }, CTX());
  return { db, repos, reservationId: res.result.id, roomId: room.result.id };
}

test('reservation.checkin: CONFIRMED -> CHECKED_IN, opens a folio, flips room OCCUPIED', async () => {
  const { db, repos, reservationId, roomId } = await freshSetup();
  const r = await commandBus.dispatch('pms.reservation.checkin', { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.status, 'CHECKED_IN');
  assert.match(r.result.folio_number, /^NEG-F-\d{4}-000001$/);
  const room = repos.pmsRepo._store.rooms.find(x => x.id === roomId);
  assert.equal(room.status, 'OCCUPIED');
  assert.ok(db.auditRows.find(x => x.event_type === 'reservation.checked_in'));
  assert.ok(db.auditRows.find(x => x.event_type === 'folio.opened'));
});

test('reservation.checkin: rejects non-CONFIRMED reservation', async () => {
  const { reservationId } = await freshSetup();
  // cancel it first to put it in CANCELLED
  await commandBus.dispatch('pms.reservation.cancel', { reservation_id: reservationId }, CTX());
  const r = await commandBus.dispatch('pms.reservation.checkin', { reservation_id: reservationId }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_transition');
});

test('reservation.checkout: blocks if folio has balance', async () => {
  const { reservationId, roomId } = await freshSetup();
  const ci = await commandBus.dispatch('pms.reservation.checkin', { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
  // Post a charge so balance != 0
  await commandBus.dispatch('pms.folio.charge.post',
    { folio_id: ci.result.folio_id, charge_type: 'ROOM', amount: 100, description: 'night 1' }, CTX());
  const co = await commandBus.dispatch('pms.reservation.checkout', { reservation_id: reservationId }, CTX());
  assert.equal(co.ok, false);
  assert.equal(co.error, 'folio_has_balance');
});

test('reservation.checkout: zero-balance folio closes + room becomes VACANT_DIRTY + housekeeping task created', async () => {
  const { db, repos, reservationId, roomId } = await freshSetup();
  const ci = await commandBus.dispatch('pms.reservation.checkin', { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
  // Post a charge then an offsetting payment to leave balance=0
  await commandBus.dispatch('pms.folio.charge.post',
    { folio_id: ci.result.folio_id, charge_type: 'ROOM',    amount:  100 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post',
    { folio_id: ci.result.folio_id, charge_type: 'PAYMENT', amount: -100 }, CTX());
  const co = await commandBus.dispatch('pms.reservation.checkout', { reservation_id: reservationId }, CTX());
  assert.equal(co.ok, true, JSON.stringify(co));
  assert.equal(co.result.status, 'CHECKED_OUT');
  // room must flip
  const room = repos.pmsRepo._store.rooms.find(x => x.id === roomId);
  assert.equal(room.status, 'VACANT_DIRTY');
  // housekeeping task created
  const tasks = repos.housekeepingRepo._store.tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].task_type, 'CLEAN_DEPARTURE');
  assert.equal(tasks[0].status, 'PENDING');
  assert.ok(db.auditRows.find(x => x.event_type === 'reservation.checked_out'));
  assert.ok(db.auditRows.find(x => x.event_type === 'folio.closed'));
  assert.ok(db.auditRows.find(x => x.event_type === 'housekeeping.task_created'));
});

test('folio.charge.post is accountingSensitive: blocked when businessDateLocked=true', async () => {
  const { reservationId, roomId } = await freshSetup();
  const ci = await commandBus.dispatch('pms.reservation.checkin', { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
  const blocked = await commandBus.dispatch('pms.folio.charge.post',
    { folio_id: ci.result.folio_id, charge_type: 'ROOM', amount: 50 },
    CTX({ businessDateLocked: true }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'business_date_locked');
});

test('housekeeping task lifecycle: create -> assign -> complete', async () => {
  await freshSetup();
  const create = await commandBus.dispatch('pms.housekeeping.task.create', { task_type: 'INSPECT', priority: 1 }, CTX());
  assert.equal(create.ok, true);
  const assign = await commandBus.dispatch('pms.housekeeping.task.assign', { task_id: create.result.id, user_id: 'u-1' }, CTX());
  assert.equal(assign.ok, true);
  assert.equal(assign.result.status, 'ASSIGNED');
  const done = await commandBus.dispatch('pms.housekeeping.task.complete', { task_id: create.result.id, verified_by: 'u-sup' }, CTX());
  assert.equal(done.ok, true);
  assert.equal(done.result.status, 'COMPLETED');
});
