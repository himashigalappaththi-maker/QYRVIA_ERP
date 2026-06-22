'use strict';

/** Phase 12 - Reservation Core (engine + room holds, over the Phase 11 Room Engine). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryRoomStore } = require('../src/pms/inventory/roomStore.memory');
const { buildRoomInventoryEngine } = require('../src/pms/inventory/RoomInventoryEngine');
const { buildRoomHoldEngine } = require('../src/reservation/holds/RoomHoldEngine');
const { buildMemoryReservationRepo } = require('../src/reservation/repository/reservationRepo.memory');
const { buildReservationEngine } = require('../src/reservation/core/ReservationEngine');
const { buildOtaIngestionService } = require('../src/reservation/services/otaIngestionService');
const { STATUS } = require('../src/reservation/models/ReservationModel');

const CTX = (propertyId) => ({ tenantId: 't1', propertyId, requestId: 'rq' });
const RANGE = { checkInDate: '2026-07-01', checkOutDate: '2026-07-03' };

function fresh({ clock, ttlMs } = {}) {
  const events = [];
  const eventBus = { publish: async (e) => { events.push(e); } };
  const roomEngine = buildRoomInventoryEngine({ store: buildMemoryRoomStore(), eventBus });
  const holdEngine = buildRoomHoldEngine({ eventBus, clock, ttlMs });
  const reservationRepo = buildMemoryReservationRepo();
  const reservationEngine = buildReservationEngine({ reservationRepo, holdEngine, roomEngine, eventBus });
  const ota = buildOtaIngestionService({ reservationEngine });
  return { events, roomEngine, holdEngine, reservationRepo, reservationEngine, ota };
}

const types = (events) => events.map((e) => e.event_type);

async function seedRooms(roomEngine, propertyId, count = 1, categoryId = 'STD') {
  return roomEngine.generateRooms(CTX(propertyId), [{ categoryId, floorId: 'F1', floorNumber: 1, count }]);
}

test('OTA ingestion creates a HELD reservation and is idempotent on re-delivery', async () => {
  const { ota, roomEngine, events } = fresh();
  await seedRooms(roomEngine, 'PA', 1);
  const booking = Object.assign({ source: 'booking.com', externalRef: 'BC-1', roomCategoryId: 'STD' }, RANGE);

  const r1 = await ota.ingest(CTX('PA'), booking);
  const r2 = await ota.ingest(CTX('PA'), booking);     // retry
  assert.equal(r1.reservationId, r2.reservationId, 'idempotent');
  assert.equal(r1.status, STATUS.HELD);
  assert.ok(r1.heldRoomId);
  const t = types(events);
  assert.ok(t.includes('reservation.created'));
  assert.ok(t.includes('reservation.held'));
  assert.ok(t.includes('room.hold_created'));
});

test('hold is created correctly and marks the room held', async () => {
  const { ota, roomEngine, holdEngine } = fresh();
  await seedRooms(roomEngine, 'PA', 1);
  const r = await ota.ingest(CTX('PA'), Object.assign({ source: 'direct', externalRef: 'D-1', roomCategoryId: 'STD' }, RANGE));
  assert.equal(holdEngine.activeHolds('PA').length, 1);
  assert.equal(holdEngine.isHeld('PA', r.heldRoomId, { dateFrom: RANGE.checkInDate, dateTo: RANGE.checkOutDate }), true);
});

test('confirm assigns a room and blocks it in the Room Engine', async () => {
  const { ota, roomEngine, reservationEngine, events } = fresh();
  await seedRooms(roomEngine, 'PA', 1);
  const r = await ota.ingest(CTX('PA'), Object.assign({ source: 'direct', externalRef: 'D-2', roomCategoryId: 'STD' }, RANGE));
  const c = await reservationEngine.confirm(CTX('PA'), r.reservationId);
  assert.equal(c.status, STATUS.CONFIRMED);
  assert.equal(c.assignedRoomId, r.heldRoomId);
  // room no longer available for the same range
  assert.equal((await roomEngine.availability(CTX('PA'), { dateFrom: RANGE.checkInDate, dateTo: RANGE.checkOutDate })).length, 0);
  const t = types(events);
  assert.ok(t.includes('reservation.confirmed'));
  assert.ok(t.includes('room.assigned'));
});

test('cancel releases the room assignment + hold', async () => {
  const { ota, roomEngine, holdEngine, reservationEngine, events } = fresh();
  await seedRooms(roomEngine, 'PA', 1);
  const r = await ota.ingest(CTX('PA'), Object.assign({ source: 'direct', externalRef: 'D-3', roomCategoryId: 'STD' }, RANGE));
  await reservationEngine.confirm(CTX('PA'), r.reservationId);
  const x = await reservationEngine.cancel(CTX('PA'), r.reservationId);
  assert.equal(x.status, STATUS.CANCELLED);
  // room freed again
  assert.equal((await roomEngine.availability(CTX('PA'), { dateFrom: RANGE.checkInDate, dateTo: RANGE.checkOutDate })).length, 1);
  assert.equal(holdEngine.activeHolds('PA').length, 0);
  assert.ok(types(events).includes('reservation.cancelled'));
  assert.ok(types(events).includes('room.hold_released'));
});

test('check-in -> complete lifecycle drives room occupancy', async () => {
  const { ota, roomEngine, reservationEngine } = fresh();
  await seedRooms(roomEngine, 'PA', 1);
  const r = await ota.ingest(CTX('PA'), Object.assign({ source: 'direct', externalRef: 'D-4', roomCategoryId: 'STD' }, RANGE));
  await reservationEngine.confirm(CTX('PA'), r.reservationId);
  const ci = await reservationEngine.checkIn(CTX('PA'), r.reservationId);
  assert.equal(ci.status, STATUS.CHECKED_IN);
  assert.equal((await roomEngine.occupancy(CTX('PA'))).occupied, 1);
  const done = await reservationEngine.complete(CTX('PA'), r.reservationId);
  assert.equal(done.status, STATUS.COMPLETED);
  const room = await roomEngine.getRoom(CTX('PA'), r.heldRoomId);
  assert.equal(room.status, 'CLEANING');
});

test('invalid lifecycle transitions throw', async () => {
  const { ota, roomEngine, reservationEngine } = fresh();
  await seedRooms(roomEngine, 'PA', 1);
  const r = await ota.ingest(CTX('PA'), Object.assign({ source: 'direct', externalRef: 'D-5', roomCategoryId: 'STD' }, RANGE));
  // can't check in a HELD (not yet confirmed) reservation
  await assert.rejects(() => reservationEngine.checkIn(CTX('PA'), r.reservationId), /invalid_transition/);
  await reservationEngine.confirm(CTX('PA'), r.reservationId);
  // can't confirm twice
  await assert.rejects(() => reservationEngine.confirm(CTX('PA'), r.reservationId), /invalid_transition/);
});

test('overbooking prevention under concurrency: only one of two parallel requests wins', async () => {
  const { ota, roomEngine, holdEngine } = fresh();
  await seedRooms(roomEngine, 'PA', 1);                 // exactly one room
  const results = await Promise.allSettled([
    ota.ingest(CTX('PA'), Object.assign({ source: 'booking.com', externalRef: 'A', roomCategoryId: 'STD' }, RANGE)),
    ota.ingest(CTX('PA'), Object.assign({ source: 'agoda', externalRef: 'B', roomCategoryId: 'STD' }, RANGE))
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one reservation succeeds');
  assert.equal(failed.length, 1, 'the other is rejected (no overbooking)');
  assert.match(failed[0].reason.message, /no_availability/);
  assert.equal(holdEngine.activeHolds('PA').length, 1);
});

test('expired holds are reclaimed and free the room', async () => {
  let now = 1_000_000;
  const { ota, roomEngine, holdEngine, reservationEngine } = fresh({ clock: () => now, ttlMs: 1000 });
  await seedRooms(roomEngine, 'PA', 1);
  const r = await ota.ingest(CTX('PA'), Object.assign({ source: 'direct', externalRef: 'D-6', roomCategoryId: 'STD' }, RANGE));
  assert.equal(holdEngine.activeHolds('PA').length, 1);

  now += 2000;                                          // advance past TTL
  const { expired } = await holdEngine.expire(CTX('PA'));
  assert.equal(expired, 1);
  assert.equal(holdEngine.activeHolds('PA').length, 0);
  // confirm now fails because the hold lapsed
  await assert.rejects(() => reservationEngine.confirm(CTX('PA'), r.reservationId), /hold_expired/);
});

test('multi-property strict isolation: no cross-property visibility or holds', async () => {
  const { ota, roomEngine, holdEngine, reservationEngine } = fresh();
  await seedRooms(roomEngine, 'PA', 1);
  const r = await ota.ingest(CTX('PA'), Object.assign({ source: 'direct', externalRef: 'D-7', roomCategoryId: 'STD' }, RANGE));

  assert.equal(await reservationEngine.get(CTX('PB'), r.reservationId), null);
  await assert.rejects(() => reservationEngine.confirm(CTX('PB'), r.reservationId), /reservation_not_found/);
  // PB has no rooms -> ingestion finds nothing (no cross-property hold)
  await assert.rejects(
    () => ota.ingest(CTX('PB'), Object.assign({ source: 'direct', externalRef: 'D-8', roomCategoryId: 'STD' }, RANGE)),
    /no_availability/);
  // the PA hold does not register under PB
  const range = { dateFrom: RANGE.checkInDate, dateTo: RANGE.checkOutDate };
  assert.equal(holdEngine.isHeld('PA', r.heldRoomId, range), true);
  assert.equal(holdEngine.isHeld('PB', r.heldRoomId, range), false);
});
