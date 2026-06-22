'use strict';

/** PMS Phase 11 - Room & Inventory Engine. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryRoomStore } = require('../src/pms/inventory/roomStore.memory');
const { buildRoomInventoryEngine } = require('../src/pms/inventory/RoomInventoryEngine');
const { buildHousekeepingSyncService } = require('../src/pms/housekeeping/HousekeepingSyncService');
const { STATUS, HOUSEKEEPING } = require('../src/pms/rooms/RoomModel');

const CTX = (propertyId) => ({ tenantId: 't1', propertyId, requestId: 'rq' });

function fresh() {
  const store = buildMemoryRoomStore();
  const events = [];
  const eventBus = { publish: async (e) => { events.push(e); } };
  const engine = buildRoomInventoryEngine({ store, eventBus });
  return { store, events, engine };
}

const types = (events) => events.map((e) => e.event_type);

test('generates rooms dynamically from configuration', async () => {
  const { engine, events } = fresh();
  const created = await engine.generateRooms(CTX('PA'), [
    { categoryId: 'DELUXE', floorId: 'F1', floorNumber: 1, count: 10 },
    { categoryId: 'STD', floorId: 'F2', floorNumber: 2, count: 20 }
  ]);
  assert.equal(created.length, 30);
  const rooms = await engine.listRooms(CTX('PA'));
  assert.equal(rooms.length, 30);
  assert.ok(rooms.find((r) => r.roomNumber === '101'), 'floor 1 numbering');
  assert.ok(rooms.find((r) => r.roomNumber === '201'), 'floor 2 numbering');
  assert.ok(rooms.every((r) => r.status === STATUS.AVAILABLE));
  assert.equal(types(events).filter((t) => t === 'room.created').length, 30);
});

test('availability is deterministic (excludes OCCUPIED, MAINTENANCE)', async () => {
  const { engine } = fresh();
  const [a, b, c] = await engine.generateRooms(CTX('PA'), [{ categoryId: 'STD', floorId: 'F1', floorNumber: 1, count: 3 }]);
  const range = { dateFrom: '2026-07-01', dateTo: '2026-07-03' };
  assert.equal((await engine.availability(CTX('PA'), range)).length, 3);
  await engine.checkIn(CTX('PA'), { roomId: a.roomId, reservationId: 'R1' });
  await engine.setMaintenance(CTX('PA'), { roomId: b.roomId });
  const avail = await engine.availability(CTX('PA'), range);
  assert.equal(avail.length, 1);
  assert.equal(avail[0].roomId, c.roomId);
});

test('check-in / check-out / cleaning lifecycle + housekeeping states', async () => {
  const { engine, events } = fresh();
  const [r] = await engine.generateRooms(CTX('PA'), [{ categoryId: 'STD', floorId: 'F1', floorNumber: 1, count: 1 }]);

  const occ = await engine.checkIn(CTX('PA'), { roomId: r.roomId, reservationId: 'RES-9' });
  assert.equal(occ.status, STATUS.OCCUPIED);
  assert.equal(occ.currentReservationId, 'RES-9');

  const out = await engine.checkOut(CTX('PA'), { roomId: r.roomId });
  assert.equal(out.status, STATUS.CLEANING);
  assert.equal(out.housekeepingState, HOUSEKEEPING.DIRTY);
  assert.equal(out.currentReservationId, null);

  const hk = buildHousekeepingSyncService({ engine });
  const clean = await hk.complete(CTX('PA'), r.roomId);
  assert.equal(clean.status, STATUS.AVAILABLE);
  assert.equal(clean.housekeepingState, HOUSEKEEPING.CLEAN);

  const t = types(events);
  assert.ok(t.includes('room.occupied'));
  assert.ok(t.includes('room.cleaned'));
  assert.ok(t.includes('room.status_changed'));
});

test('invalid lifecycle transitions are rejected', async () => {
  const { engine } = fresh();
  const [r] = await engine.generateRooms(CTX('PA'), [{ categoryId: 'STD', floorId: 'F1', floorNumber: 1, count: 1 }]);
  // can't check out a room that was never checked in
  await assert.rejects(() => engine.checkOut(CTX('PA'), { roomId: r.roomId }), /invalid_transition/);
  await engine.checkIn(CTX('PA'), { roomId: r.roomId });
  // can't check in an already-occupied room
  await assert.rejects(() => engine.checkIn(CTX('PA'), { roomId: r.roomId }), /invalid_transition/);
  // can't set maintenance on an occupied room
  await assert.rejects(() => engine.setMaintenance(CTX('PA'), { roomId: r.roomId }), /invalid_transition/);
});

test('multi-property isolation: no cross-property visibility or mutation', async () => {
  const { engine } = fresh();
  const [r] = await engine.generateRooms(CTX('PA'), [{ categoryId: 'STD', floorId: 'F1', floorNumber: 1, count: 1 }]);
  assert.equal((await engine.listRooms(CTX('PB'))).length, 0);
  assert.equal(await engine.getRoom(CTX('PB'), r.roomId), null);
  await assert.rejects(() => engine.checkIn(CTX('PB'), { roomId: r.roomId }), /room_not_found/);
  await assert.rejects(() => engine.listRooms({ tenantId: 't1', requestId: 'rq' }), /property_required/);
});

test('overbooking prevention: overlapping blocks on the same room are refused', async () => {
  const { engine } = fresh();
  const [r] = await engine.generateRooms(CTX('PA'), [{ categoryId: 'STD', floorId: 'F1', floorNumber: 1, count: 1 }]);

  await engine.block(CTX('PA'), { roomId: r.roomId, dateFrom: '2026-07-01', dateTo: '2026-07-05', reservationId: 'r1' });
  // overlapping -> rejected (no double booking)
  await assert.rejects(
    () => engine.block(CTX('PA'), { roomId: r.roomId, dateFrom: '2026-07-03', dateTo: '2026-07-06', reservationId: 'r2' }),
    /room_unavailable/);
  // adjacent (half-open) -> allowed
  const ok = await engine.block(CTX('PA'), { roomId: r.roomId, dateFrom: '2026-07-05', dateTo: '2026-07-07', reservationId: 'r3' });
  assert.equal(ok.reservationId, 'r3');

  // availability reflects the blocks
  assert.equal((await engine.availability(CTX('PA'), { dateFrom: '2026-07-02', dateTo: '2026-07-04' })).length, 0);
  assert.equal((await engine.availability(CTX('PA'), { dateFrom: '2026-07-10', dateTo: '2026-07-11' })).length, 1);

  // releasing frees the room
  await engine.release(CTX('PA'), { roomId: r.roomId, reservationId: 'r1' });
  assert.equal((await engine.availability(CTX('PA'), { dateFrom: '2026-07-02', dateTo: '2026-07-04' })).length, 1);
});

test('occupancy snapshot', async () => {
  const { engine } = fresh();
  const rooms = await engine.generateRooms(CTX('PA'), [{ categoryId: 'STD', floorId: 'F1', floorNumber: 1, count: 4 }]);
  await engine.checkIn(CTX('PA'), { roomId: rooms[0].roomId });
  const snap = await engine.occupancy(CTX('PA'));
  assert.equal(snap.total, 4);
  assert.equal(snap.occupied, 1);
  assert.equal(snap.available, 3);
  assert.equal(snap.occupancyPct, 25);
});
