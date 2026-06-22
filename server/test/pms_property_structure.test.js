'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands } = require('../src/commands/pms');
const { makeQueries  } = require('../src/queries/pms');

const CTX = {
  requestId: 'rq-pms', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
};

function freshBuses() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'AGH', name: 'Acme', currency: 'LKR', active: true });
  makeCommands({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeQueries ({ pmsRepo: repos.pmsRepo }).forEach((q) => queryBus.register(q));
  return { db, repos };
}

beforeEach(() => { /* per-test fresh in each test */ });

test('building.create persists + emits building.created', async () => {
  const { db } = freshBuses();
  const r = await commandBus.dispatch('pms.building.create', { code: 'MAIN', name: 'Main Wing' }, CTX);
  assert.equal(r.ok, true);
  assert.ok(r.result.id);
  assert.ok(db.auditRows.find(x => x.event_type === 'building.created'));
});

test('floor.create requires building_id + emits floor.created', async () => {
  const { db } = freshBuses();
  const b = await commandBus.dispatch('pms.building.create', { code: 'B1', name: 'B1' }, CTX);
  const f = await commandBus.dispatch('pms.floor.create', { building_id: b.result.id, code: '1', name: 'First' }, CTX);
  assert.equal(f.ok, true);
  assert.ok(db.auditRows.find(x => x.event_type === 'floor.created'));
});

test('roomtype.create validates and persists', async () => {
  freshBuses();
  const r = await commandBus.dispatch('pms.roomtype.create', {
    code: 'DLX-K', name: 'Deluxe King',
    max_adults: 2, max_children: 1, base_occupancy: 2, extra_bed_capacity: 1
  }, CTX);
  assert.equal(r.ok, true);
});

test('roomtype.create rejects negative max_adults', async () => {
  freshBuses();
  const r = await commandBus.dispatch('pms.roomtype.create', { code: 'X', name: 'X', max_adults: 0 }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'validation_failed');
});

test('room.create rejects unknown room_type_id', async () => {
  freshBuses();
  const r = await commandBus.dispatch('pms.room.create', { room_number: '101', room_type_id: 'rt_999' }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'room_type_not_found');
});

test('room.create + room.list happy path', async () => {
  freshBuses();
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Standard' }, CTX);
  const rm = await commandBus.dispatch('pms.room.create', { room_number: '101', room_type_id: rt.result.id }, CTX);
  assert.equal(rm.ok, true);
  const list = await queryBus.execute('pms.room.list', {}, CTX);
  assert.equal(list.ok, true);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].room_number, '101');
});

test('room.status.change persists and emits room.status.changed with from/to', async () => {
  const { db } = freshBuses();
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Standard' }, CTX);
  const rm = await commandBus.dispatch('pms.room.create', { room_number: '202', room_type_id: rt.result.id }, CTX);
  const ch = await commandBus.dispatch('pms.room.status.change', { room_id: rm.result.id, status: 'OUT_OF_ORDER' }, CTX);
  assert.equal(ch.ok, true);
  assert.equal(ch.result.status, 'OUT_OF_ORDER');
  const ev = db.auditRows.find(x => x.event_type === 'room.status_changed');
  assert.equal(ev.payload.from, 'VACANT_CLEAN');
  assert.equal(ev.payload.to,   'OUT_OF_ORDER');
});

test('room.status.change rejects invalid status', async () => {
  freshBuses();
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Standard' }, CTX);
  const rm = await commandBus.dispatch('pms.room.create', { room_number: '303', room_type_id: rt.result.id }, CTX);
  const ch = await commandBus.dispatch('pms.room.status.change', { room_id: rm.result.id, status: 'TOTAL_GIBBERISH' }, CTX);
  assert.equal(ch.ok, false);
  assert.equal(ch.error, 'invalid_status');
});

test('room.activate / deactivate flip flag + emit events', async () => {
  const { db } = freshBuses();
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, CTX);
  const rm = await commandBus.dispatch('pms.room.create', { room_number: '404', room_type_id: rt.result.id }, CTX);
  await commandBus.dispatch('pms.room.deactivate', { room_id: rm.result.id }, CTX);
  await commandBus.dispatch('pms.room.activate',   { room_id: rm.result.id }, CTX);
  const types = db.auditRows.map(x => x.event_type).filter(t => t === 'room.activated' || t === 'room.deactivated');
  assert.ok(types.includes('room.deactivated'));
  assert.ok(types.includes('room.activated'));
});

test('feature.create + feature.attach', async () => {
  const { db } = freshBuses();
  const rt = await commandBus.dispatch('pms.roomtype.create', { code: 'STD', name: 'Std' }, CTX);
  const rm = await commandBus.dispatch('pms.room.create', { room_number: '505', room_type_id: rt.result.id }, CTX);
  const f  = await commandBus.dispatch('pms.feature.create', { code: 'OV', name: 'Ocean View' }, CTX);
  const at = await commandBus.dispatch('pms.feature.attach', { room_id: rm.result.id, feature_id: f.result.id }, CTX);
  assert.equal(at.ok, true);
  assert.ok(db.auditRows.find(x => x.event_type === 'room_feature.attached'));
});

test('room.list requires propertyId in ctx', async () => {
  freshBuses();
  const r = await queryBus.execute('pms.room.list', {}, Object.assign({}, CTX, { propertyId: null }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'property_required');
});
