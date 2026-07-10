'use strict';

/**
 * Phase 54 D10 — Confirm recheck and ARI ceiling/floor guard tests (Items 9, 10).
 * Tests adjustSold wiring in confirmBooking and the memoryStore ceiling/floor guards.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildBookingService }          = require('../src/booking-engine/bookingService');
const { buildMockPaymentProvider }     = require('../src/payment/mockPaymentProvider');
const { buildPaymentStateStoreMemory } = require('../src/payment/paymentStateStore');
const { buildPaymentAttemptLogMemory } = require('../src/payment/paymentAttemptLog');
const { buildMemoryAriStore }          = require('../src/ari/store/memoryStore');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

function fakeCommandBus() {
  let n = 0;
  return {
    async dispatch(name) { return { ok: true, result: { id: 'res-' + (++n) } }; }
  };
}

function makeAvailEngine(available = true) {
  return { async check() { return { available, rooms: available ? 5 : 0 }; } };
}

function fakePricing() {
  return { quote() { return { ok: true, total: 230, base_rate: 200, taxes: 30, discounts: 0, currency: 'USD' }; } };
}

function fakeValidator() {
  return { validate() { return { ok: true }; } };
}

function buildSvc(adjuster) {
  const stateStore = buildPaymentStateStoreMemory();
  const attemptLog = buildPaymentAttemptLogMemory();
  const svc = buildBookingService({
    commandBus:         fakeCommandBus(),
    availabilityEngine: makeAvailEngine(true),
    pricingEngine:      fakePricing(),
    validator:          fakeValidator(),
    paymentProvider:    buildMockPaymentProvider(),
    paymentStateStore:  stateStore,
    paymentAttemptLog:  attemptLog,
    inventoryAdjuster:  adjuster,
  });
  return { svc, stateStore };
}

function validInitInput(over = {}) {
  return Object.assign({
    channel: 'DIRECT', room_type_id: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03',
    adults: 2, holder_guest_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    currency: 'USD',
  }, over);
}

// 1. confirmBooking with roomTypeId/arrival/departure provided -> adjustSold called with delta: +1
test('confirmBooking: adjustSold called with delta +1 when roomTypeId provided', async () => {
  const adjCalls = [];
  const fakeAdjuster = {
    async adjustSold(args) { adjCalls.push(args); return { sold: 1, version: 1 }; }
  };

  const { svc, stateStore } = buildSvc(fakeAdjuster);

  const initResult = await svc.initiateBooking(validInitInput(), CTX);
  assert.ok(initResult.ok, 'initiate should succeed');

  const reservationId = initResult.result.reservation_id;
  const paymentId     = initResult.result.payment_id;

  const confirmResult = await svc.confirmBooking({
    reservationId,
    paymentId,
    roomTypeId: 'rt1',
    arrival:    '2026-08-01',
    departure:  '2026-08-03',
    adults:     2,
  }, CTX);

  assert.ok(confirmResult.ok, 'confirm should succeed');
  const adjCall = adjCalls.find(c => c.delta === 1);
  assert.ok(adjCall, 'adjustSold should be called with delta +1');
  assert.equal(adjCall.roomTypeId, 'rt1');
  assert.equal(adjCall.tenantId,   't1');
  assert.equal(adjCall.arrival,    '2026-08-01');
  assert.equal(adjCall.departure,  '2026-08-03');
});

// 2. adjustSold ceiling guard: if sold is at physical, adjustSold(+1) returns null (inventory full)
test('memoryStore.adjustSold: sold at physical ceiling -> returns null', () => {
  const store = buildMemoryAriStore();
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 2, sold: 2, blocked: 0 });

  const result = store.adjustSold({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', delta: 1 });
  assert.equal(result, null, 'ceiling guard: adjustSold should return null when sold = physical');
});

// 3. adjustSold floor guard: if sold is 0, adjustSold(-1) returns null (no under-floor)
test('memoryStore.adjustSold: sold at 0, adjustSold(-1) returns null', () => {
  const store = buildMemoryAriStore();
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 5, sold: 0, blocked: 0 });

  const result = store.adjustSold({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', delta: -1 });
  assert.equal(result, null, 'floor guard: adjustSold should return null when sold = 0');
});

// 4. adjustSold succeeds when sold is below physical ceiling
test('memoryStore.adjustSold: sold below ceiling -> returns updated sold', () => {
  const store = buildMemoryAriStore();
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 5, sold: 2, blocked: 0 });

  const result = store.adjustSold({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', delta: 1 });
  assert.ok(result, 'should succeed below ceiling');
  assert.equal(result.sold, 3);
});

// 5. adjustSold with overbookingBuffer allows exceeding physical up to buffer
test('memoryStore.adjustSold: sold can exceed physical up to overbookingBuffer', () => {
  const store = buildMemoryAriStore();
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 2, sold: 2, blocked: 0, overbookingBuffer: 1 });

  // physical=2, overbookingBuffer=1, ceiling=3, sold=2 -> +1 -> sold=3 -> ok
  const result = store.adjustSold({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', delta: 1 });
  assert.ok(result, 'should allow up to physical + overbookingBuffer');
  assert.equal(result.sold, 3);
});

// 6. adjustSold ceiling guard with overbookingBuffer: sold at ceiling -> returns null
test('memoryStore.adjustSold: sold at physical+overbookingBuffer ceiling -> returns null', () => {
  const store = buildMemoryAriStore();
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 2, sold: 3, blocked: 0, overbookingBuffer: 1 });

  const result = store.adjustSold({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', delta: 1 });
  assert.equal(result, null, 'ceiling guard with buffer: null when sold = physical + buffer');
});

// 7. adjustSold for non-existent cell returns null
test('memoryStore.adjustSold: non-existent cell returns null', () => {
  const store = buildMemoryAriStore();
  const result = store.adjustSold({ propertyId: 'p1', roomTypeId: 'rt99', date: '2026-08-01', delta: 1 });
  assert.equal(result, null, 'non-existent cell should return null');
});

// 8. Two concurrent confirmBooking calls for same slot: ceiling guard means at most physical slots sold
test('confirmBooking concurrent: ceiling guard prevents oversell beyond physical', async () => {
  // Use a real memoryStore adjuster that enforces ceiling at physical=1
  const ariStore = buildMemoryAriStore();
  ariStore.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 1, sold: 0, blocked: 0 });
  ariStore.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-02', physical: 1, sold: 0, blocked: 0 });

  const { buildAriInventoryAdjuster } = require('../src/booking-engine/ariInventoryAdjuster');
  const adjuster = buildAriInventoryAdjuster({ ariStore });

  const stateStore = buildPaymentStateStoreMemory();
  const attemptLog = buildPaymentAttemptLogMemory();

  // Build two separate booking services each with independent commandBus
  // so they can both get through to the confirm step
  function makeService(customStateStore) {
    return buildBookingService({
      commandBus:         fakeCommandBus(),
      availabilityEngine: makeAvailEngine(true),
      pricingEngine:      fakePricing(),
      validator:          fakeValidator(),
      paymentProvider:    buildMockPaymentProvider(),
      paymentStateStore:  customStateStore || stateStore,
      paymentAttemptLog:  attemptLog,
      inventoryAdjuster:  adjuster,
    });
  }

  // Both share the same ariStore so the ceiling applies globally
  const svc1 = makeService();
  const svc2 = makeService();

  // Initiate two separate bookings
  const init1 = await svc1.initiateBooking(validInitInput(), CTX);
  const init2 = await svc2.initiateBooking(validInitInput(), CTX);
  assert.ok(init1.ok, 'first initiate should succeed');
  assert.ok(init2.ok, 'second initiate should succeed');

  // Now confirm both concurrently (same ariStore, physical=1)
  const [c1, c2] = await Promise.all([
    svc1.confirmBooking({ reservationId: init1.result.reservation_id, paymentId: init1.result.payment_id, roomTypeId: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', adults: 2 }, CTX),
    svc2.confirmBooking({ reservationId: init2.result.reservation_id, paymentId: init2.result.payment_id, roomTypeId: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', adults: 2 }, CTX),
  ]);

  // Both confirmations will "succeed" at PMS level (PMS confirm is independent),
  // but the ARI store will cap sold at physical=1. At least one adjuster call must return null.
  // We verify that sold never exceeds physical (1) in the store.
  const cellDay1 = ariStore.inventory('p1', '2026-08-01', '2026-08-02');
  assert.ok(cellDay1.length > 0, 'inventory cell should exist');
  assert.ok(cellDay1[0].sold <= cellDay1[0].physical, 'sold must not exceed physical after concurrent confirms');
});

// 9. confirmBooking without roomTypeId -> adjustSold skipped, no crash
test('confirmBooking: no roomTypeId provided -> adjustSold skipped gracefully', async () => {
  const adjCalls = [];
  const fakeAdjuster = {
    async adjustSold(args) { adjCalls.push(args); return { sold: 1, version: 1 }; }
  };

  const { svc } = buildSvc(fakeAdjuster);

  const initResult = await svc.initiateBooking(validInitInput(), CTX);
  assert.ok(initResult.ok);

  const reservationId = initResult.result.reservation_id;
  const paymentId     = initResult.result.payment_id;

  // No roomTypeId, arrival, departure
  const confirmResult = await svc.confirmBooking({ reservationId, paymentId }, CTX);
  assert.ok(confirmResult.ok, 'confirm should succeed even without roomTypeId');
  assert.equal(adjCalls.length, 0, 'adjustSold should not be called when roomTypeId is absent');
});

// 10. adjustSold decrease from positive sold value succeeds
test('memoryStore.adjustSold: valid decrease from sold=2 -> sold=1', () => {
  const store = buildMemoryAriStore();
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 5, sold: 2, blocked: 0 });

  const result = store.adjustSold({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', delta: -1 });
  assert.ok(result, 'decrease should succeed');
  assert.equal(result.sold, 1);
});
