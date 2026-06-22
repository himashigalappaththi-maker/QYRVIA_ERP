'use strict';

/** Phase 13 - Front Desk / Stay Lifecycle (consumes Phase 11 Room + Phase 12 Reservation). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryRoomStore } = require('../src/pms/inventory/roomStore.memory');
const { buildRoomInventoryEngine } = require('../src/pms/inventory/RoomInventoryEngine');
const { buildRoomHoldEngine } = require('../src/reservation/holds/RoomHoldEngine');
const { buildMemoryReservationRepo } = require('../src/reservation/repository/reservationRepo.memory');
const { buildReservationEngine } = require('../src/reservation/core/ReservationEngine');
const { buildOtaIngestionService } = require('../src/reservation/services/otaIngestionService');
const { buildFrontDeskEngine } = require('../src/pms/frontdesk/FrontDeskEngine');

const CTX = (propertyId) => ({ tenantId: 't1', propertyId, requestId: 'rq' });
const RANGE = { checkInDate: '2026-07-01', checkOutDate: '2026-07-03' };
const types = (events) => events.map((e) => e.event_type);

function setup() {
  const events = [];
  const eventBus = { publish: async (e) => { events.push(e); } };
  const roomEngine = buildRoomInventoryEngine({ store: buildMemoryRoomStore(), eventBus });
  const holdEngine = buildRoomHoldEngine({ eventBus });
  const reservationRepo = buildMemoryReservationRepo();
  const reservationEngine = buildReservationEngine({ reservationRepo, holdEngine, roomEngine, eventBus });
  const ota = buildOtaIngestionService({ reservationEngine });
  const frontDesk = buildFrontDeskEngine({ reservationEngine, roomEngine, eventBus });
  return { events, roomEngine, reservationEngine, ota, frontDesk };
}

async function confirmedReservation(ctx, { roomEngine, ota, reservationEngine }, { rooms = 1, ref = 'R', categoryId = 'STD' } = {}) {
  await roomEngine.generateRooms(ctx, [{ categoryId, floorId: 'F1', floorNumber: 1, count: rooms }]);
  const r = await ota.ingest(ctx, Object.assign({ source: 'direct', externalRef: ref, roomCategoryId: categoryId }, RANGE));
  await reservationEngine.confirm(ctx, r.reservationId);
  return r.reservationId;
}

test('full stay lifecycle: check-in occupies room, check-out sends it to cleaning', async () => {
  const s = setup();
  const ctx = CTX('PA');
  const resId = await confirmedReservation(ctx, s);

  const stay = await s.frontDesk.checkInGuest(ctx, resId);
  assert.equal(stay.status, 'IN_STAY');
  assert.equal((await s.roomEngine.getRoom(ctx, stay.roomId)).status, 'OCCUPIED');
  assert.equal((await s.reservationEngine.get(ctx, resId)).status, 'CHECKED_IN');
  assert.ok(types(s.events).includes('stay.started'));
  assert.ok(types(s.events).includes('room.charge_started'));

  const out = await s.frontDesk.checkOutGuest(ctx, resId);
  assert.equal(out.status, 'CHECKED_OUT');
  assert.equal(out.checkoutType, 'STANDARD');
  assert.equal((await s.roomEngine.getRoom(ctx, stay.roomId)).status, 'CLEANING');
  assert.equal((await s.reservationEngine.get(ctx, resId)).status, 'COMPLETED');
  assert.ok(types(s.events).includes('stay.ended'));
  assert.ok(types(s.events).includes('housekeeping.queued'));
});

test('moveRoom: old room -> CLEANING, new room -> OCCUPIED, stay tracks the new room', async () => {
  const s = setup();
  const ctx = CTX('PA');
  const resId = await confirmedReservation(ctx, s, { rooms: 2 });
  const stay = await s.frontDesk.checkInGuest(ctx, resId);
  const allRooms = await s.roomEngine.listRooms(ctx);
  const target = allRooms.find((r) => r.roomId !== stay.roomId).roomId;

  const moved = await s.frontDesk.moveRoom(ctx, resId, target);
  assert.equal(moved.roomId, target);
  assert.equal((await s.roomEngine.getRoom(ctx, stay.roomId)).status, 'CLEANING');
  assert.equal((await s.roomEngine.getRoom(ctx, target)).status, 'OCCUPIED');
  assert.ok(types(s.events).includes('stay.room_moved'));
});

test('early checkout is tagged EARLY', async () => {
  const s = setup();
  const ctx = CTX('PA');
  const resId = await confirmedReservation(ctx, s);
  await s.frontDesk.checkInGuest(ctx, resId);
  const out = await s.frontDesk.earlyCheckOut(ctx, resId);
  assert.equal(out.status, 'CHECKED_OUT');
  assert.equal(out.checkoutType, 'EARLY');
});

test('late checkout records the extension and emits a billing hook', async () => {
  const s = setup();
  const ctx = CTX('PA');
  const resId = await confirmedReservation(ctx, s);
  await s.frontDesk.checkInGuest(ctx, resId);
  const before = types(s.events).filter((t) => t === 'room.charge_started').length;
  const stay = await s.frontDesk.lateCheckOut(ctx, resId, { until: '2026-07-03T14:00:00Z' });
  assert.equal(stay.lateCheckoutUntil, '2026-07-03T14:00:00Z');
  assert.equal(stay.status, 'IN_STAY');
  assert.equal(types(s.events).filter((t) => t === 'room.charge_started').length, before + 1);
  // can still complete the checkout afterwards
  const out = await s.frontDesk.checkOutGuest(ctx, resId, { type: 'LATE' });
  assert.equal(out.status, 'CHECKED_OUT');
  assert.equal(out.checkoutType, 'LATE');
});

test('invalid operations are rejected', async () => {
  const s = setup();
  const ctx = CTX('PA');
  // check-in a HELD (not yet confirmed) reservation
  await s.roomEngine.generateRooms(ctx, [{ categoryId: 'STD', floorId: 'F1', floorNumber: 1, count: 1 }]);
  const held = await s.ota.ingest(ctx, Object.assign({ source: 'direct', externalRef: 'H1', roomCategoryId: 'STD' }, RANGE));
  await assert.rejects(() => s.frontDesk.checkInGuest(ctx, held.reservationId), /reservation_not_confirmed/);

  // checkout with no stay
  await assert.rejects(() => s.frontDesk.checkOutGuest(ctx, held.reservationId), /stay_not_found/);

  // double checkout
  await s.reservationEngine.confirm(ctx, held.reservationId);
  await s.frontDesk.checkInGuest(ctx, held.reservationId);
  await s.frontDesk.checkOutGuest(ctx, held.reservationId);
  await assert.rejects(() => s.frontDesk.checkOutGuest(ctx, held.reservationId), /invalid_stay_transition/);
});

test('multi-property isolation: cannot check in another property\'s reservation', async () => {
  const s = setup();
  const resId = await confirmedReservation(CTX('PA'), s);
  await assert.rejects(() => s.frontDesk.checkInGuest(CTX('PB'), resId), /reservation_not_found/);
  assert.equal(await s.frontDesk.getStay(CTX('PB'), resId), null);
});
