'use strict';

/** Booking Engine v1 - orchestration over PMS (commandBus), deterministic pricing, idempotency. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingEngine, buildPricingEngine } = require('../src/booking-engine');
const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

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
  const eng = buildBookingEngine({ commandBus: bus });
  const r = await eng.service.createBooking(baseInput(), CTX);
  assert.equal(r.ok, true);
  assert.equal(bus.calls[0].name, 'pms.reservation.create');
  assert.equal(bus.calls[0].input.amount, 230);      // 100*2 nights + 15% tax = 200 + 30
  assert.equal(r.reservation_id, 'res-1');
});

// 2. update flow -> correct commandBus routing
test('update flow dispatches pms.reservation.update', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus });
  const r = await eng.service.updateBooking(baseInput({ reservation_id: 'res-9' }), CTX);
  assert.equal(r.ok, true);
  assert.equal(bus.calls[0].name, 'pms.reservation.update');
  assert.equal(bus.calls[0].input.reservation_id, 'res-9');
});

// 3. cancel flow -> PMS cancel dispatched
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

// 5. invalid adult rule -> rejection
test('adult rule violation is rejected', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus });
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
  const eng = buildBookingEngine({ commandBus: bus });
  const r = await eng.service.createBooking(baseInput({ channel: 'BOOKING_COM', external_ref: 'bc-77' }), CTX);
  assert.equal(r.ok, true);
  assert.equal(bus.calls[0].name, 'pms.reservation.create');
  assert.equal(bus.calls[0].input.source_channel, 'BOOKING_COM');
});

// 8. duplicate external_ref -> update not duplicate
test('duplicate external_ref routes to UPDATE, never a second CREATE', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({ commandBus: bus, bookingStore: store });
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
  const eng = buildBookingEngine({ commandBus: bus, onEvent: (e) => events.push(e) });
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
