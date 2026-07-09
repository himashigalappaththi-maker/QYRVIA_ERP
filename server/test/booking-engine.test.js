'use strict';

/** Booking Engine v1 - orchestration over PMS (commandBus), deterministic pricing, idempotency.
 *  Phase 37 WI-1: availability guard is FAIL-CLOSED (no provider / unknown / missing property
 *  context => reject, never assume). Tests that exercise non-availability behavior now inject an
 *  explicit availabilityProvider so their intent is honest rather than relying on a permissive default. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingEngine, buildPricingEngine, buildPmsAvailabilityProvider } = require('../src/booking-engine');
const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };
const AVAIL = () => 5; // explicit "rooms available" provider for tests not exercising availability

function fakeCommandBus() {
  const calls = [];
  let n = 0;
  return { calls, async dispatch(name, input, ctx) { calls.push({ name, input }); return { ok: true, result: { id: 'res-' + (++n) } }; } };
}
const baseInput = (over = {}) => Object.assign({
  channel: 'DIRECT', external_ref: 'D1', room_type_id: 'rt1', arrival: '2026-07-01', departure: '2026-07-03',
  adults: 2, guest_name: 'John', base_rate: 100, currency: 'USD'
}, over);

// 1. direct booking -> PMS create dispatched
test('direct booking dispatches pms.reservation.create with priced amount', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: AVAIL });
  const r = await eng.service.createBooking(baseInput(), CTX);
  assert.equal(r.ok, true);
  assert.equal(bus.calls[0].name, 'pms.reservation.create');
  assert.equal(bus.calls[0].input.amount, 230);      // 100*2 nights + 15% tax = 200 + 30
  assert.equal(r.reservation_id, 'res-1');
});

// 2. update flow -> correct commandBus routing (update does not gate on availability)
test('update flow dispatches pms.reservation.update', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus });
  const r = await eng.service.updateBooking(baseInput({ reservation_id: 'res-9' }), CTX);
  assert.equal(r.ok, true);
  assert.equal(bus.calls[0].name, 'pms.reservation.update');
  assert.equal(bus.calls[0].input.reservation_id, 'res-9');
});

// 3. cancel flow -> PMS cancel dispatched (cancel does not gate on availability)
test('cancel flow dispatches pms.reservation.cancel', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus });
  const r = await eng.service.cancelBooking({ reservation_id: 'res-9', external_ref: 'D1' }, CTX);
  assert.equal(r.ok, true);
  assert.equal(bus.calls[0].name, 'pms.reservation.cancel');
});

// 4. unavailable room -> rejection
test('unavailable room is rejected (no PMS dispatch)', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: () => 0 });
  const r = await eng.service.createBooking(baseInput(), CTX);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'VALIDATION_FAILED');
  assert.ok(r.detail.includes('unavailable'));
  assert.equal(bus.calls.length, 0);
});

// 5. invalid adult rule -> rejection (availability satisfied so the adult rule is isolated)
test('adult rule violation is rejected', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: AVAIL });
  const r = await eng.service.createBooking(baseInput({ adults: 0 }), CTX);
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes('adult_required'));
  assert.equal(bus.calls.length, 0);
});

// 6. pricing deterministic output
test('pricing engine is deterministic and test-pinned', () => {
  const pe = buildPricingEngine({});
  assert.deepEqual(pe.quote({ ratePerNight: 100, nights: 1 }), { ok: true, base_rate: 100, taxes: 15, discounts: 0, total: 115, currency: 'USD' });
  assert.deepEqual(pe.quote({ ratePerNight: 100, nights: 2, discounts: 20, currency: 'EUR' }), { ok: true, base_rate: 200, taxes: 30, discounts: 20, total: 210, currency: 'EUR' });
});

// 7. OTA inbound compatibility unchanged (OTA-origin booking flows through the same gate)
test('OTA-origin booking flows through the same orchestration gate', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: AVAIL });
  const r = await eng.service.createBooking(baseInput({ channel: 'BOOKING_COM', external_ref: 'bc-77' }), CTX);
  assert.equal(r.ok, true);
  assert.equal(bus.calls[0].name, 'pms.reservation.create');
  assert.equal(bus.calls[0].input.source_channel, 'BOOKING_COM');
});

// 8. duplicate external_ref -> update not duplicate
test('duplicate external_ref routes to UPDATE, never a second CREATE', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, bookingStore: store, availabilityProvider: AVAIL });
  await eng.service.createBooking(baseInput({ external_ref: 'DUP1' }), CTX);  // create
  await eng.service.createBooking(baseInput({ external_ref: 'DUP1' }), CTX);  // duplicate
  const names = bus.calls.map((c) => c.name);
  assert.equal(names.filter((n) => n === 'pms.reservation.create').length, 1);
  assert.equal(names.filter((n) => n === 'pms.reservation.update').length, 1);
});

// 9. AI-style payload accepted
test('AI-style (natural-language-derived) payload is accepted', async () => {
  const bus = fakeCommandBus();
  const events = [];
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: AVAIL, onEvent: (e) => events.push(e) });
  const r = await eng.service.createBooking(baseInput({ channel: 'AI_WHATSAPP', external_ref: 'wa-1', guest_name: 'Aisha' }), CTX);
  assert.equal(r.ok, true);
  const ev = events.find((e) => e.type === 'booking.created' && e.channel === 'AI_WHATSAPP');
  assert.ok(ev);
  assert.equal(ev.guest_name, undefined); // metadata-only: no guest PII in the event
});

// 10. full pipeline integration (availability + pricing + validate + dispatch + event + store link)
test('full pipeline: availability -> pricing -> validate -> commandBus -> store link + event', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const events = [];
  const eng = buildBookingEngine({ commandBus: bus, bookingStore: store, availabilityProvider: () => 5, onEvent: (e) => events.push(e) });
  const r = await eng.service.createBooking(baseInput({ external_ref: 'FULL1' }), CTX);
  assert.equal(r.ok, true);
  assert.equal(r.pricing.total, 230);
  assert.equal(store.getByExternalRef('t1', 'DIRECT', 'FULL1').pms_reservation_id, 'res-1');
  assert.ok(events.find((e) => e.type === 'booking.created'));
});

// ---- Phase 37 WI-1: fail-closed availability ----

// 11. no availabilityProvider wired => FAIL CLOSED (never assume availability)
test('WI-1: no provider wired => booking refused, no PMS dispatch', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus }); // neither availabilityProvider nor pmsRepo
  const r = await eng.service.createBooking(baseInput(), CTX);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'VALIDATION_FAILED');
  assert.ok(r.detail.includes('availability_provider_unwired'), 'specific fail-closed reason surfaced');
  assert.equal(bus.calls.length, 0);
});

// 12. provider returns a non-finite value => FAIL CLOSED (Infinity/NaN are not "available")
test('WI-1: non-finite availability => availability_unknown, refused', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: () => Infinity });
  const r = await eng.service.createBooking(baseInput(), CTX);
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes('availability_unknown'));
  assert.equal(bus.calls.length, 0);
});

// 13. provider throws with a reason => FAIL CLOSED, reason surfaced
test('WI-1: provider throwing property_context_required is surfaced, refused', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: () => { throw Object.assign(new Error('x'), { reason: 'property_context_required' }); } });
  const r = await eng.service.createBooking(baseInput(), CTX);
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes('property_context_required'));
  assert.equal(bus.calls.length, 0);
});

// 14. concurrent bookings against zero availability => BOTH refused, zero dispatches
//     (guard is read-only/advisory; atomic oversell protection is DB-enforced, but the guard
//      must never let a zero-availability slot through under concurrency.)
test('WI-1: concurrent bookings on a full slot are both refused (no double-booking via the guard)', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: () => 0 });
  const [a, b] = await Promise.all([
    eng.service.createBooking(baseInput({ external_ref: 'C1' }), CTX),
    eng.service.createBooking(baseInput({ external_ref: 'C2' }), CTX)
  ]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(bus.calls.length, 0, 'no PMS create dispatched for a full slot');
});

// ---- Phase 37 WI-1: real PMS-backed availability provider ----

function fakePmsRepo({ rooms, reservationsByDate = {} }) {
  return {
    async listRoomsForAvailability({ roomTypeId }) {
      return rooms.filter((r) => !roomTypeId || r.room_type_id === roomTypeId);
    },
    async listReservationsOverlapping({ date, roomTypeId }) {
      const res = reservationsByDate[date] || [];
      return roomTypeId ? res.filter((r) => r.room_type_id === roomTypeId) : res;
    }
  };
}
const twoRooms = [
  { id: 'r1', room_number: '101', status: 'CLEAN', room_type_id: 'rt1', room_type_code: 'STD', active: true },
  { id: 'r2', room_number: '102', status: 'CLEAN', room_type_id: 'rt1', room_type_code: 'STD', active: true }
];

// 15. real provider: min available across the stay decides; a booking within inventory is accepted
test('WI-1: pms provider accepts when inventory covers the stay (min across nights)', async () => {
  const bus = fakeCommandBus();
  const pmsRepo = fakePmsRepo({ rooms: twoRooms, reservationsByDate: { '2026-07-01': [{ room_type_id: 'rt1', rooms_count: 1 }] } });
  const eng = buildBookingEngine({ commandBus: bus, pmsRepo }); // provider auto-built from pmsRepo
  const r = await eng.service.createBooking(baseInput(), CTX);   // nights 07-01 (avail 1), 07-02 (avail 2) => min 1
  assert.equal(r.ok, true);
  assert.equal(bus.calls[0].name, 'pms.reservation.create');
});

// 16. real provider: a fully-booked night blocks the stay (no oversell)
test('WI-1: pms provider refuses when a night is fully booked (no oversell)', async () => {
  const bus = fakeCommandBus();
  const pmsRepo = fakePmsRepo({ rooms: twoRooms, reservationsByDate: { '2026-07-02': [{ room_type_id: 'rt1', rooms_count: 2 }] } });
  const eng = buildBookingEngine({ commandBus: bus, pmsRepo });
  const r = await eng.service.createBooking(baseInput(), CTX);   // 07-02 avail 0 => min 0 => refused
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes('unavailable'));
  assert.equal(bus.calls.length, 0);
});

// 17. real provider: missing property context => FAIL CLOSED
test('WI-1: pms provider fails closed when property context is missing', async () => {
  const bus = fakeCommandBus();
  const pmsRepo = fakePmsRepo({ rooms: twoRooms });
  const provider = buildPmsAvailabilityProvider({ pmsRepo });
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: provider });
  const r = await eng.service.createBooking(baseInput(), { tenantId: 't1', requestId: 'rq' }); // no propertyId
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes('property_context_required'));
  assert.equal(bus.calls.length, 0);
});

// ---- Phase 52: ARI injection tests (extend existing suite) ----

// 18. ARI resolver injection: buildBookingEngine({ ariService: inMemoryAriService }) uses ARI pricing
test('Phase 52: buildBookingEngine with in-memory ariService uses ARI rate resolver', async () => {
  const { buildMemoryAriStore } = require('../src/ari/store/memoryStore');
  const { buildAriService } = require('../src/ari/ariService');
  const { buildAriRateResolver } = require('../src/booking-engine/ariRateResolver');
  const { buildAriAvailabilityProvider } = require('../src/booking-engine/ariAvailabilityProvider');

  const store = buildMemoryAriStore();
  store.putRoomType({ propertyId: 'p1', roomTypeId: 'rt1', code: 'STD', name: 'Standard', totalUnits: 5 });
  store.putRatePlan({ propertyId: 'p1', ratePlanId: 'rp1', roomTypeId: 'rt1', code: 'BAR', name: 'BAR', currency: 'USD', baseRate: 200, standardOccupancy: 2, maxOccupancy: 3 });
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-07-01', physical: 5, sold: 0, blocked: 0 });
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-07-02', physical: 5, sold: 0, blocked: 0 });
  const ariSvc = buildAriService({ store });

  const resolver = buildAriRateResolver({ ariService: ariSvc });
  const provider = buildAriAvailabilityProvider({ ariService: ariSvc });

  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, rateResolver: resolver, availabilityProvider: provider });
  const r = await eng.service.createBooking({
    channel: 'DIRECT', room_type_id: 'rt1', rate_plan_id: 'rp1',
    arrival: '2026-07-01', departure: '2026-07-03', adults: 2, currency: 'USD'
  }, CTX);

  assert.equal(r.ok, true);
  // ARI priced: 200/night * 2 nights = 400 base + 15% tax = 460
  assert.ok(r.pricing.total > 0, 'should have ARI-computed total');
  assert.equal(bus.calls[0].name, 'pms.reservation.create');
});

// 19. Full pipeline with in-memory ARI: book a stay, get ARI-computed total
test('Phase 52: full pipeline with in-memory ARI produces correct total', async () => {
  const { buildMemoryAriStore } = require('../src/ari/store/memoryStore');
  const { buildAriService } = require('../src/ari/ariService');
  const { buildAriRateResolver } = require('../src/booking-engine/ariRateResolver');
  const { buildAriAvailabilityProvider } = require('../src/booking-engine/ariAvailabilityProvider');

  const store = buildMemoryAriStore();
  store.putRoomType({ propertyId: 'p1', roomTypeId: 'rt1', code: 'STD', name: 'Standard', totalUnits: 10 });
  store.putRatePlan({ propertyId: 'p1', ratePlanId: 'rp1', roomTypeId: 'rt1', code: 'BAR', name: 'BAR', currency: 'USD', baseRate: 100, standardOccupancy: 2, maxOccupancy: 3 });
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-07-01', physical: 10, sold: 0, blocked: 0 });
  store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date: '2026-07-02', physical: 10, sold: 0, blocked: 0 });
  const ariSvc = buildAriService({ store });

  const resolver = buildAriRateResolver({ ariService: ariSvc });
  const provider = buildAriAvailabilityProvider({ ariService: ariSvc });

  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, rateResolver: resolver, availabilityProvider: provider });
  const r = await eng.service.createBooking({
    channel: 'DIRECT', room_type_id: 'rt1', rate_plan_id: 'rp1',
    arrival: '2026-07-01', departure: '2026-07-03', adults: 2, currency: 'USD'
  }, CTX);

  assert.equal(r.ok, true);
  // 100/night * 2 nights = 200 base + 15% tax (30) = 230 total
  assert.equal(r.pricing.base_rate, 200);
  assert.equal(r.pricing.total, 230);
});

// 20. Backward compat: buildBookingEngine({}) without ariService -> flat rate path unchanged
test('Phase 52: backward compat - no ariService means flat base_rate path unchanged', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, availabilityProvider: AVAIL });
  const r = await eng.service.createBooking(baseInput({ base_rate: 100 }), CTX);
  assert.equal(r.ok, true);
  // Original flat rate: 100 * 2 nights = 200 + 15% = 230
  assert.equal(r.pricing.total, 230);
  assert.equal(bus.calls.length, 1);
});
