'use strict';

/**
 * Phase 63 P0-3 / P0-5 / P0-8 — Booking Engine commercial-integrity regressions.
 *
 * P0-3  confirmBooking must never confirm a reservation without positive
 *       payment evidence. Every gate used to be `if (paymentState && ...)`, so a
 *       NULL state row skipped all of them and verifyResult defaulted to
 *       {ok:true,status:'paid'}.
 * P0-5  availability must satisfy the number of ROOMS requested, not merely
 *       "more than zero rooms exist".
 * P0-8  confirm and the hold-expiry sweep must not both be able to act on one
 *       hold (money taken for a just-cancelled reservation).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingService }          = require('../src/booking-engine/bookingService');
const { buildAvailabilityEngine }      = require('../src/booking-engine/availabilityEngine');
const { buildPaymentStateStoreMemory } = require('../src/payment/paymentStateStore');
const { buildMockPaymentProvider }     = require('../src/payment/mockPaymentProvider');
const { buildHoldExpirySweep }         = require('../src/payment/holdExpirySweep');

const CTX = { tenantId: 't-1', propertyId: 'p-1', requestId: 'r-1', actorId: 'a-1' };

function fakeCommandBus(overrides = {}) {
  const calls = [];
  return {
    calls,
    async dispatch(name, payload, ctx) {
      calls.push({ name, payload, ctx });
      if (overrides[name]) return overrides[name](payload, ctx);
      if (name === 'pms.reservation.create')  return { ok: true, result: { id: 'res-1' } };
      if (name === 'pms.reservation.confirm') return { ok: true, result: { id: 'res-1', confirmation_number: 'CN-1' } };
      if (name === 'pms.reservation.cancel')  return { ok: true, result: { id: 'res-1' } };
      return { ok: true, result: {} };
    }
  };
}

function svc(opts = {}) {
  return buildBookingService(Object.assign({
    commandBus: opts.commandBus || fakeCommandBus(),
    availabilityEngine: { async check() { return { available: true, rooms: 5, requested: 1 }; } },
    paymentProvider: buildMockPaymentProvider(),
    paymentStateStore: buildPaymentStateStoreMemory(),
    rateResolver: () => 100
  }, opts));
}

// ---------------------------------------------------------------------------
// P0-3 — fail closed
// ---------------------------------------------------------------------------

test('P0-3: confirm with NO payment state row is rejected (was: silently confirmed)', async () => {
  const bus = fakeCommandBus();
  const s = svc({ commandBus: bus, paymentStateStore: buildPaymentStateStoreMemory() });

  const r = await s.confirmBooking({ reservationId: 'res-unknown', paymentId: 'pay-1' }, CTX);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payment_state_missing');
  assert.ok(!bus.calls.some((c) => c.name === 'pms.reservation.confirm'),
    'the PMS must never be told to confirm without payment evidence');
});

test('P0-3: confirm with NO paymentId is rejected', async () => {
  const store = buildPaymentStateStoreMemory();
  await store.upsert({ reservation_id: 'res-1', payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 60000).toISOString() });
  const bus = fakeCommandBus();

  const r = await svc({ commandBus: bus, paymentStateStore: store })
    .confirmBooking({ reservationId: 'res-1' }, CTX);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payment_reference_required');
  assert.ok(!bus.calls.some((c) => c.name === 'pms.reservation.confirm'));
});

test('P0-3: confirm with the payment subsystem un-wired is rejected, not assumed paid', async () => {
  // src/index.js builds provider + state store + attempt log in ONE try/catch,
  // so a single misconfiguration drops all three. That must not confirm bookings.
  const bus = fakeCommandBus();
  const r = await buildBookingService({
    commandBus: bus,
    availabilityEngine: { async check() { return { available: true, rooms: 5 }; } },
    paymentProvider: null,
    paymentStateStore: null,
    rateResolver: () => 100
  }).confirmBooking({ reservationId: 'res-1', paymentId: 'pay-1' }, CTX);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payment_subsystem_unavailable');
  assert.ok(!bus.calls.some((c) => c.name === 'pms.reservation.confirm'));
});

test('P0-3: a pending hold with no expiry is rejected (unbounded hold)', async () => {
  const store = buildPaymentStateStoreMemory();
  await store.upsert({ reservation_id: 'res-1', payment_status: 'pending_payment' }); // no hold_expires_at
  const bus = fakeCommandBus();

  const r = await svc({ commandBus: bus, paymentStateStore: store })
    .confirmBooking({ reservationId: 'res-1', paymentId: 'pay-1' }, CTX);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payment_hold_missing_expiry');
});

test('P0-3: a provider that does not report "paid" is rejected', async () => {
  const store = buildPaymentStateStoreMemory();
  await store.upsert({ reservation_id: 'res-1', payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 60000).toISOString() });
  const bus = fakeCommandBus();

  const r = await svc({
    commandBus: bus,
    paymentStateStore: store,
    paymentProvider: { async initiate() { return { ok: true, paymentId: 'x' }; },
                       async verify() { return { ok: false, status: 'failed' }; } }
  }).confirmBooking({ reservationId: 'res-1', paymentId: 'pay-1' }, CTX);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payment_verification_failed');
  assert.ok(!bus.calls.some((c) => c.name === 'pms.reservation.confirm'));
});

test('P0-3: the happy path still confirms and marks the state paid', async () => {
  const store = buildPaymentStateStoreMemory();
  await store.upsert({ reservation_id: 'res-1', payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 60000).toISOString() });
  const bus = fakeCommandBus();

  const r = await svc({ commandBus: bus, paymentStateStore: store })
    .confirmBooking({ reservationId: 'res-1', paymentId: 'pay-1' }, CTX);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(bus.calls.some((c) => c.name === 'pms.reservation.confirm'));
  const after = await store.getByReservationId('res-1');
  assert.equal(after.payment_status, 'paid');
});

test('P0-3: requirePayment:false is an explicit, deliberate opt-out (pay-on-arrival)', async () => {
  const bus = fakeCommandBus();
  const r = await buildBookingService({
    commandBus: bus,
    availabilityEngine: { async check() { return { available: true, rooms: 5 }; } },
    rateResolver: () => 100,
    requirePayment: false
  }).confirmBooking({ reservationId: 'res-1' }, CTX);

  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// P0-5 — rooms requested
// ---------------------------------------------------------------------------

test('P0-5: a 3-room request against 1 available room is refused (was: booked 1 room)', async () => {
  const eng = buildAvailabilityEngine({ availabilityProvider: () => 1 });
  const r = await eng.check(CTX, { room_type_id: 'rt1', rooms_count: 3 });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'insufficient_rooms_available');
  assert.equal(r.rooms, 1);
  assert.equal(r.requested, 3);
});

test('P0-5: a 3-room request against 3 available rooms is accepted', async () => {
  const eng = buildAvailabilityEngine({ availabilityProvider: () => 3 });
  const r = await eng.check(CTX, { room_type_id: 'rt1', rooms_count: 3 });
  assert.equal(r.available, true);
  assert.equal(r.requested, 3);
});

test('P0-5: absent/invalid rooms_count means exactly one room, never zero', async () => {
  const eng = buildAvailabilityEngine({ availabilityProvider: () => 0 });
  for (const rooms_count of [undefined, null, 0, -5, 'abc', 1]) {
    const r = await eng.check(CTX, { room_type_id: 'rt1', rooms_count });
    assert.equal(r.requested, 1, JSON.stringify(rooms_count) + ' must resolve to 1 room');
    assert.equal(r.available, false, 'zero inventory is never available');
  }
});

test('P0-5: rooms_count reaches the PMS create command', async () => {
  const bus = fakeCommandBus();
  await svc({ commandBus: bus }).createBooking(
    { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03',
      adults: 2, rooms_count: 3, holder_guest_id: 'g-1', channel: 'DIRECT' },
    CTX
  );
  const create = bus.calls.find((c) => c.name === 'pms.reservation.create');
  assert.ok(create, 'a create must have been dispatched');
  assert.equal(create.payload.rooms_count, 3);
});

// ---------------------------------------------------------------------------
// P0-4 — the PMS create contract is fully populated
// ---------------------------------------------------------------------------

test('P0-4: primary_adult_guest_id is sent (its absence broke every real booking)', async () => {
  const bus = fakeCommandBus();
  await svc({ commandBus: bus }).createBooking(
    { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03',
      adults: 2, holder_guest_id: 'g-1', channel: 'DIRECT' },
    CTX
  );
  const create = bus.calls.find((c) => c.name === 'pms.reservation.create');
  assert.equal(create.payload.primary_adult_guest_id, 'g-1',
    'falls back to the holder when no distinct primary adult is given');
});

test('P0-4: an explicit primary adult, rate plan and child policy are all forwarded', async () => {
  const bus = fakeCommandBus();
  await svc({ commandBus: bus }).createBooking(
    { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03', adults: 2,
      holder_guest_id: 'g-1', primary_adult_guest_id: 'g-2',
      rate_plan_id: 'rp-1', child_policy_id: 'cp-1', child_ages: [4, 9], channel: 'DIRECT' },
    CTX
  );
  const p = bus.calls.find((c) => c.name === 'pms.reservation.create').payload;
  assert.equal(p.primary_adult_guest_id, 'g-2');
  assert.equal(p.rate_plan_id, 'rp-1');
  assert.equal(p.child_policy_id, 'cp-1');
  assert.deepEqual(p.child_ages, [4, 9]);
});

// ---------------------------------------------------------------------------
// P0-6 — the hold must consume inventory
// ---------------------------------------------------------------------------

test('P0-6: initiateBooking parks the reservation in PENDING_PAYMENT, not INQUIRY', async () => {
  const bus = fakeCommandBus();
  await svc({ commandBus: bus }).initiateBooking(
    { room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03',
      adults: 2, holder_guest_id: 'g-1', channel: 'DIRECT' },
    CTX
  );
  const create = bus.calls.find((c) => c.name === 'pms.reservation.create');
  assert.equal(create.payload.initial_status, 'PENDING_PAYMENT',
    'an INQUIRY consumes no inventory, so every concurrent guest saw the same last room');
});

// ---------------------------------------------------------------------------
// P0-8 — confirm vs sweep must have exactly one winner
// ---------------------------------------------------------------------------

test('P0-8: once the sweep claims a hold, confirm cannot charge for it', async () => {
  const store = buildPaymentStateStoreMemory();
  await store.upsert({ reservation_id: 'res-1', payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() - 1000).toISOString() }); // already expired

  const bus = fakeCommandBus();
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });
  const swept = await sweep.sweep(CTX);
  assert.equal(swept.swept, 1);

  const r = await svc({ commandBus: bus, paymentStateStore: store })
    .confirmBooking({ reservationId: 'res-1', paymentId: 'pay-1' }, CTX);

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_payment_state',
    'the hold is already failed — confirm must not proceed');
});

test('P0-8: once confirm claims a hold, the sweep leaves it alone', async () => {
  const store = buildPaymentStateStoreMemory();
  await store.upsert({ reservation_id: 'res-1', payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 60000).toISOString() });

  const bus = fakeCommandBus();
  const r = await svc({ commandBus: bus, paymentStateStore: store })
    .confirmBooking({ reservationId: 'res-1', paymentId: 'pay-1' }, CTX);
  assert.equal(r.ok, true);

  // Force the (now paid) row to look expired; the sweep must still skip it.
  const row = await store.getByReservationId('res-1');
  await store.upsert({ reservation_id: 'res-1', payment_status: row.payment_status,
    hold_expires_at: new Date(Date.now() - 1000).toISOString() });

  const before = bus.calls.filter((c) => c.name === 'pms.reservation.cancel').length;
  const sweep = buildHoldExpirySweep({ paymentStateStore: store, commandBus: bus });
  await sweep.sweep(CTX);
  const after = bus.calls.filter((c) => c.name === 'pms.reservation.cancel').length;

  assert.equal(after, before, 'a paid reservation must never be cancelled by the sweep');
  assert.equal((await store.getByReservationId('res-1')).payment_status, 'paid');
});

test('P0-8: transitionPending is a true compare-and-set — only one caller wins', async () => {
  const store = buildPaymentStateStoreMemory();
  await store.upsert({ reservation_id: 'res-1', payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 60000).toISOString() });

  const results = await Promise.all([
    store.transitionPending('res-1', 'paid',   { paid_at: 'now' }),
    store.transitionPending('res-1', 'failed', { failed_at: 'now' }),
    store.transitionPending('res-1', 'failed', { failed_at: 'now' })
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'exactly one transition may succeed');
});

test('P0-8: a PMS confirm failure after capture is reported for reconciliation, not swallowed', async () => {
  const store = buildPaymentStateStoreMemory();
  await store.upsert({ reservation_id: 'res-1', payment_status: 'pending_payment',
    hold_expires_at: new Date(Date.now() + 60000).toISOString() });

  const bus = fakeCommandBus({
    'pms.reservation.confirm': async () => ({ ok: false, error: 'invalid_transition' })
  });

  const r = await svc({ commandBus: bus, paymentStateStore: store })
    .confirmBooking({ reservationId: 'res-1', paymentId: 'pay-1' }, CTX);

  assert.equal(r.ok, false);
  assert.equal(r.payment_captured, true);
  assert.equal(r.requires_reconciliation, true);
  assert.equal((await store.getByReservationId('res-1')).payment_status, 'paid',
    'the state must NOT be rolled back to pending — that would re-open the sweep race');
});
