'use strict';

// Phase 21 - backend exposure gap closure. Verifies the newly added commands
// (reservation update / room_move) and the new read queries (front desk, folio,
// housekeeping, night audit, IAM) behave correctly through the buses.

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands } = require('../src/commands/pms');
const { makeQueries }  = require('../src/queries/pms');
const { makeCheckinFolioCommands } = require('../src/commands/pms/checkinFolio');
const { makeIamQueries } = require('../src/queries/iam');

const CTX = {
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID, businessDate: '2026-06-21',
  actorId: fx.USER_ID, actorName: 'Jane', roleCodes: ['super_admin'], roleIds: [], permissions: []
};

async function setup() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true, current_business_date: '2026-06-21', business_date_locked: false });
  makeCommands({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeCheckinFolioCommands({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo }).forEach((c) => commandBus.register(c));
  makeQueries({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo, nightAuditRepo: repos.nightAuditRepo }).forEach((q) => queryBus.register(q));
  makeIamQueries({ identityRepo: repos.identityRepo }).forEach((q) => queryBus.register(q));

  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'Alice' }, CTX);
  const rt    = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std', max_adults: 2, base_occupancy: 2 }, CTX);
  return { repos, db, adultId: adult.result.id, roomTypeId: rt.result.id };
}

async function makeReservation(adultId, roomTypeId, over = {}) {
  const r = await commandBus.dispatch('pms.reservation.create', Object.assign({
    holder_guest_id: adultId, primary_adult_guest_id: adultId, room_type_id: roomTypeId,
    arrival_date: '2026-06-20', departure_date: '2026-06-25', adults: 2, children: 0
  }, over), CTX);
  return r.result.id;
}

test('pms.reservation.update edits a pre-stay booking + audits change', async () => {
  const { adultId, roomTypeId, db } = await setup();
  const id = await makeReservation(adultId, roomTypeId);
  const u = await commandBus.dispatch('pms.reservation.update', { reservation_id: id, adults: 3, notes: 'high floor' }, CTX);
  assert.equal(u.ok, true);
  const ev = db.auditRows.find((x) => x.event_type === 'reservation.updated');
  assert.ok(ev);
  assert.ok(ev.payload.changed.includes('adults'));
});

test('pms.reservation.update rejects invalid date range + post-checkin edit', async () => {
  const { adultId, roomTypeId } = await setup();
  const id = await makeReservation(adultId, roomTypeId);
  const bad = await commandBus.dispatch('pms.reservation.update', { reservation_id: id, arrival_date: '2026-07-10', departure_date: '2026-07-10' }, CTX);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_date_range');

  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: id }, CTX);
  const room = await commandBus.dispatch('pms.room.create', { room_type_id: roomTypeId, room_number: '101' }, CTX);
  await commandBus.dispatch('pms.reservation.checkin', { reservation_id: id, assigned_room_id: room.result.id }, CTX);
  const after = await commandBus.dispatch('pms.reservation.update', { reservation_id: id, notes: 'x' }, CTX);
  assert.equal(after.ok, false);
  assert.equal(after.error, 'invalid_state');
});

test('pms.reservation.room_move flips rooms for an in-house guest', async () => {
  const { repos, adultId, roomTypeId } = await setup();
  const id = await makeReservation(adultId, roomTypeId);
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: id }, CTX);
  const r1 = await commandBus.dispatch('pms.room.create', { room_type_id: roomTypeId, room_number: '201' }, CTX);
  const r2 = await commandBus.dispatch('pms.room.create', { room_type_id: roomTypeId, room_number: '202' }, CTX);
  await commandBus.dispatch('pms.reservation.checkin', { reservation_id: id, assigned_room_id: r1.result.id }, CTX);

  const mv = await commandBus.dispatch('pms.reservation.room_move', { reservation_id: id, new_room_id: r2.result.id }, CTX);
  assert.equal(mv.ok, true);
  assert.equal(mv.result.assigned_room_id, r2.result.id);
  assert.equal(mv.result.from_room_id, r1.result.id);
  const oldRoom = await repos.pmsRepo.findRoomById(fx.TENANT_A, r1.result.id);
  const newRoom = await repos.pmsRepo.findRoomById(fx.TENANT_A, r2.result.id);
  assert.equal(oldRoom.status, 'VACANT_DIRTY');
  assert.equal(newRoom.status, 'OCCUPIED');
});

test('pms.reservation.room_move requires CHECKED_IN', async () => {
  const { adultId, roomTypeId } = await setup();
  const id = await makeReservation(adultId, roomTypeId);
  const r2 = await commandBus.dispatch('pms.room.create', { room_type_id: roomTypeId, room_number: '301' }, CTX);
  const mv = await commandBus.dispatch('pms.reservation.room_move', { reservation_id: id, new_room_id: r2.result.id }, CTX);
  assert.equal(mv.ok, false);
  assert.equal(mv.error, 'invalid_state');
});

test('front desk queries: arrivals / departures / in-house', async () => {
  const { adultId, roomTypeId } = await setup();
  const a = await makeReservation(adultId, roomTypeId);          // arrival 2026-06-20
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: a }, CTX);

  const arrivals = await queryBus.execute('pms.frontdesk.arrivals', { date: '2026-06-21' }, CTX);
  assert.equal(arrivals.ok, true);
  assert.equal(arrivals.data.length, 1);

  const room = await commandBus.dispatch('pms.room.create', { room_type_id: roomTypeId, room_number: '401' }, CTX);
  await commandBus.dispatch('pms.reservation.checkin', { reservation_id: a, assigned_room_id: room.result.id }, CTX);

  const inhouse = await queryBus.execute('pms.frontdesk.inhouse', {}, CTX);
  assert.equal(inhouse.data.length, 1);
  const departures = await queryBus.execute('pms.frontdesk.departures', { date: '2026-06-25' }, CTX);
  assert.equal(departures.data.length, 1);                       // departure 2026-06-25 <= date
});

test('folio reads: list + byId with lines', async () => {
  const { adultId, roomTypeId } = await setup();
  const id = await makeReservation(adultId, roomTypeId);
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: id }, CTX);
  const room = await commandBus.dispatch('pms.room.create', { room_type_id: roomTypeId, room_number: '501' }, CTX);
  const ci = await commandBus.dispatch('pms.reservation.checkin', { reservation_id: id, assigned_room_id: room.result.id }, CTX);
  const folioId = ci.result.folio_id;

  const list = await queryBus.execute('pms.folio.list', {}, CTX);
  assert.equal(list.ok, true);
  assert.ok(list.data.find((f) => f.id === folioId));

  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 100 }, CTX);
  const byId = await queryBus.execute('pms.folio.byId', { id: folioId }, CTX);
  assert.equal(byId.ok, true);
  assert.equal(byId.data.id, folioId);
  assert.ok(Array.isArray(byId.data.lines) && byId.data.lines.length >= 1);
});

test('housekeeping reads: task list + room status', async () => {
  const { adultId, roomTypeId } = await setup();
  await commandBus.dispatch('pms.room.create', { room_type_id: roomTypeId, room_number: '601' }, CTX);
  await commandBus.dispatch('pms.housekeeping.task.create', { task_type: 'CLEAN_DEPARTURE', room_id: 'x' }, CTX);
  const tasks = await queryBus.execute('pms.housekeeping.task.list', {}, CTX);
  assert.equal(tasks.ok, true);
  assert.ok(tasks.data.length >= 1);
  const rooms = await queryBus.execute('pms.housekeeping.room_status', {}, CTX);
  assert.equal(rooms.ok, true);
  assert.ok(rooms.data.length >= 1);
});

test('night audit reads: status + history', async () => {
  const { repos } = await setup();
  const status0 = await queryBus.execute('pms.night_audit.status', {}, CTX);
  assert.equal(status0.ok, true);
  assert.equal(status0.data.state, 'NONE');

  await repos.nightAuditRepo.insertRun({ tenant_id: fx.TENANT_A, property_id: fx.PROP_ID, business_date: '2026-06-21', next_business_date: '2026-06-22', status: 'COMPLETED' });
  const status1 = await queryBus.execute('pms.night_audit.status', {}, CTX);
  assert.equal(status1.data.state, 'COMPLETED');
  const history = await queryBus.execute('pms.night_audit.history', {}, CTX);
  assert.ok(history.data.length >= 1);
});

test('IAM reads: users + roles (no secrets leaked)', async () => {
  const { repos } = await setup();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A, username: 'frontdesk1', full_name: 'Front Desk', email: 'fd@x.io', password_hash: 'SECRET' },
    [{ id: 'role-front_desk', code: 'front_desk', scope: 'TENANT', property_id: null }]);
  const users = await queryBus.execute('iam.users.list', {}, CTX);
  assert.equal(users.ok, true);
  const u = users.data.find((x) => x.username === 'frontdesk1');
  assert.ok(u);
  assert.equal(u.password_hash, undefined);
  const roles = await queryBus.execute('iam.roles.list', {}, CTX);
  assert.equal(roles.ok, true);
  assert.ok(roles.data.find((r) => r.code === 'front_desk'));
});
