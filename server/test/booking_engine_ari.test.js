'use strict';

/**
 * Phase 52 — Booking Engine ARI integration tests.
 * Tests: ARI rate resolver, ARI availability provider, adjustSold wiring,
 * full ARI pipeline with in-memory store, and backward compat with no ARI.
 *
 * Test isolation: uses buildMemoryAriStore and builds ariService in-process.
 * No require from ari/ in the booking-engine test path — injected as opaque deps.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ARI deps — built here and injected opaquely into booking-engine
const { buildMemoryAriStore } = require('../src/ari/store/memoryStore');
const { buildAriService }     = require('../src/ari/ariService');

// Booking engine adapters (Phase 52 new files)
const { buildAriRateResolver }          = require('../src/booking-engine/ariRateResolver');
const { buildAriAvailabilityProvider }  = require('../src/booking-engine/ariAvailabilityProvider');
const { buildAriInventoryAdjuster }     = require('../src/booking-engine/ariInventoryAdjuster');

// Engine and service
const { buildBookingEngine, buildBookingService } = require('../src/booking-engine');

// ---- helpers ----------------------------------------------------------------

function fakeCommandBus() {
  const calls = [];
  let n = 0;
  return {
    calls,
    async dispatch(name, input) { calls.push({ name, input }); return { ok: true, result: { id: 'res-' + (++n) } }; }
  };
}

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

/** Build a seeded in-memory ARI store + service with one room type, one rate plan, and inventory. */
function buildSeededAri({ physical = 5, sold = 0, baseRate = 200, arrival = '2026-08-01', departure = '2026-08-03' } = {}) {
  const store = buildMemoryAriStore();
  store.putRoomType({ propertyId: 'p1', roomTypeId: 'rt1', code: 'STD', name: 'Standard', totalUnits: physical });
  store.putRatePlan({ propertyId: 'p1', ratePlanId: 'rp1', roomTypeId: 'rt1', code: 'BAR', name: 'Best Available', currency: 'USD', baseRate, standardOccupancy: 2, maxOccupancy: 3 });

  // Seed inventory cells for each night in [arrival, departure)
  let t = Date.parse(arrival + 'T00:00:00Z');
  const end = Date.parse(departure + 'T00:00:00Z');
  while (t < end) {
    const d = new Date(t);
    const date = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    store.putInventoryCell({ propertyId: 'p1', roomTypeId: 'rt1', date, physical, sold, blocked: 0 });
    t += 86400000;
  }

  const service = buildAriService({ store });
  return { store, service };
}

// ---- D1: ARI rate resolver --------------------------------------------------

test('ariRateResolver: quoteStay total -> per-night scalar', async () => {
  const { service } = buildSeededAri({ baseRate: 200, arrival: '2026-08-01', departure: '2026-08-03' });
  const resolver = buildAriRateResolver({ ariService: service });

  const rate = await resolver({
    tenantId: 't1', propertyId: 'p1',
    room_type_id: 'rt1', rate_plan_id: 'rp1',
    arrival: '2026-08-01', departure: '2026-08-03',
    adults: 2, channel: null
  });

  // 2 nights * 200/night = 400 total; per-night = 400 / 2 = 200
  assert.equal(typeof rate, 'number');
  assert.ok(rate > 0, 'rate should be positive');
  assert.equal(rate, 200); // per-night
});

test('ariRateResolver: zero-nights guard (arrival === departure) -> returns 0', async () => {
  const { service } = buildSeededAri({ baseRate: 200 });
  const resolver = buildAriRateResolver({ ariService: service });

  // quoteStay will throw for invalid range; resolver should catch and return 0
  const rate = await resolver({
    tenantId: 't1', propertyId: 'p1',
    room_type_id: 'rt1', rate_plan_id: 'rp1',
    arrival: '2026-08-01', departure: '2026-08-01', // same date => 0 nights
    adults: 2
  });

  assert.equal(rate, 0);
});

test('ariRateResolver: bookable:false (no inventory) -> returns 0', async () => {
  // Seed with sold === physical so nothing is available
  const { service } = buildSeededAri({ physical: 2, sold: 2, baseRate: 200 });
  const resolver = buildAriRateResolver({ ariService: service });

  const rate = await resolver({
    tenantId: 't1', propertyId: 'p1',
    room_type_id: 'rt1', rate_plan_id: 'rp1',
    arrival: '2026-08-01', departure: '2026-08-03',
    adults: 2
  });

  assert.equal(rate, 0);
});

test('ariRateResolver: factory throws if ariService not provided', () => {
  assert.throws(() => buildAriRateResolver({}), /ariService/);
});

// ---- D2: ARI availability provider ------------------------------------------

test('ariAvailabilityProvider: available > 0 -> returns positive count', async () => {
  const { service } = buildSeededAri({ physical: 5, sold: 0 });
  const provider = buildAriAvailabilityProvider({ ariService: service });

  const avail = await provider(CTX, {
    room_type_id: 'rt1', rate_plan_id: 'rp1',
    arrival: '2026-08-01', departure: '2026-08-03'
  });

  assert.ok(Number.isFinite(avail));
  assert.ok(avail > 0, 'should return positive count when rooms available');
});

test('ariAvailabilityProvider: fully booked (sold == physical) -> returns 0', async () => {
  const { service } = buildSeededAri({ physical: 3, sold: 3 });
  const provider = buildAriAvailabilityProvider({ ariService: service });

  const avail = await provider(CTX, {
    room_type_id: 'rt1', rate_plan_id: 'rp1',
    arrival: '2026-08-01', departure: '2026-08-03'
  });

  assert.equal(avail, 0);
});

test('ariAvailabilityProvider: missing tenantId -> throws property_context_required', async () => {
  const { service } = buildSeededAri();
  const provider = buildAriAvailabilityProvider({ ariService: service });

  await assert.rejects(
    () => provider({ propertyId: 'p1' }, { room_type_id: 'rt1', rate_plan_id: 'rp1', arrival: '2026-08-01', departure: '2026-08-03' }),
    (err) => {
      assert.equal(err.reason, 'property_context_required');
      return true;
    }
  );
});

test('ariAvailabilityProvider: missing propertyId -> throws property_context_required', async () => {
  const { service } = buildSeededAri();
  const provider = buildAriAvailabilityProvider({ ariService: service });

  await assert.rejects(
    () => provider({ tenantId: 't1' }, { room_type_id: 'rt1', rate_plan_id: 'rp1', arrival: '2026-08-01', departure: '2026-08-03' }),
    (err) => {
      assert.equal(err.reason, 'property_context_required');
      return true;
    }
  );
});

// ---- D3/D4: adjustSold wiring -----------------------------------------------

test('adjustSold called with delta +1 after successful create', async () => {
  const calls = [];
  const fakeAdjuster = {
    async adjustSold(args) { calls.push(args); return { sold: 1, version: 2 }; }
  };

  const bus = fakeCommandBus();
  // buildBookingService returns { createBooking, updateBooking, cancelBooking } directly
  const svc = buildBookingService({
    commandBus: bus,
    availabilityEngine: { async check() { return { available: true, rooms: 5 }; } },
    pricingEngine: { quote() { return { ok: true, total: 230, base_rate: 200, taxes: 30, discounts: 0, currency: 'USD' }; } },
    validator: { validate() { return { ok: true }; } },
    inventoryAdjuster: fakeAdjuster
  });

  const r = await svc.createBooking({
    channel: 'DIRECT', room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03',
    adults: 2, base_rate: 100
  }, CTX);

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].delta, 1);
  assert.equal(calls[0].roomTypeId, 'rt1');
  assert.equal(calls[0].tenantId, 't1');
});

test('adjustSold called with delta -1 after successful cancel (when room_type_id provided)', async () => {
  const calls = [];
  const fakeAdjuster = {
    async adjustSold(args) { calls.push(args); return { sold: 0, version: 3 }; }
  };

  const bus = fakeCommandBus();
  const svc = buildBookingService({
    commandBus: bus,
    inventoryAdjuster: fakeAdjuster
  });

  const r = await svc.cancelBooking({
    reservation_id: 'res-5',
    room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03',
    channel: 'DIRECT'
  }, CTX);

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].delta, -1);
  assert.equal(calls[0].roomTypeId, 'rt1');
});

test('adjustSold null return handled without error (floor guard case)', async () => {
  const fakeAdjuster = {
    async adjustSold() { return null; } // floor guard: sold already 0
  };

  const bus = fakeCommandBus();
  const svc = buildBookingService({
    commandBus: bus,
    availabilityEngine: { async check() { return { available: true, rooms: 5 }; } },
    pricingEngine: { quote() { return { ok: true, total: 230, base_rate: 200, taxes: 30, discounts: 0, currency: 'USD' }; } },
    validator: { validate() { return { ok: true }; } },
    inventoryAdjuster: fakeAdjuster
  });

  // Should not throw even when adjustSold returns null
  const r = await svc.createBooking({
    channel: 'DIRECT', room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03',
    adults: 2, base_rate: 100
  }, CTX);

  assert.equal(r.ok, true); // booking still confirmed
});

test('adjustSold NOT called on idempotency/update path (duplicate external_ref)', async () => {
  const calls = [];
  const fakeAdjuster = {
    async adjustSold(args) { calls.push(args); return { sold: 1, version: 2 }; }
  };

  // Build a minimal booking store that makes the second call look like a duplicate
  const fakeStore = {
    getByExternalRef(tenantId, channel, ref) {
      if (ref === 'DUP99') return { pms_reservation_id: 'res-existing', id: 'store-1' };
      return null;
    },
    async upsert(f) { return { item: { id: 'store-1', pms_reservation_id: null }, created: false }; },
    async setPmsReservationId() {}
  };

  const bus = fakeCommandBus();
  const svc = buildBookingService({
    commandBus: bus,
    bookingStore: fakeStore,
    availabilityEngine: { async check() { return { available: true, rooms: 5 }; } },
    pricingEngine: { quote() { return { ok: true, total: 230, base_rate: 200, taxes: 30, discounts: 0, currency: 'USD' }; } },
    validator: { validate() { return { ok: true }; } },
    inventoryAdjuster: fakeAdjuster
  });

  // This will route to updateBooking because external_ref already exists in store
  const r = await svc.createBooking({
    channel: 'DIRECT', external_ref: 'DUP99', room_type_id: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03', adults: 2, base_rate: 100
  }, CTX);

  // Should be ok (update path)
  assert.equal(r.ok, true);
  // adjustSold should NOT have been called on the update/idempotency path
  assert.equal(calls.length, 0, 'adjustSold must NOT be called on the idempotency path');
});

// ---- Full ARI pipeline: in-memory ariService + buildBookingEngine -----------

test('Full ARI pipeline: in-memory ariService -> bookable quote -> create booking -> adjustSold called', async () => {
  const { store, service: ariSvc } = buildSeededAri({ physical: 10, sold: 0, baseRate: 150 });

  const adjCalls = [];
  const fakeAdjuster = {
    async adjustSold(args) { adjCalls.push(args); return { sold: 1, version: 2 }; }
  };

  const resolver = buildAriRateResolver({ ariService: ariSvc });
  const availProvider = buildAriAvailabilityProvider({ ariService: ariSvc });

  const bus = fakeCommandBus();
  const eng = buildBookingEngine({
    commandBus: bus,
    availabilityProvider: availProvider,
    rateResolver: resolver,
    inventoryAdjuster: fakeAdjuster
  });

  const r = await eng.service.createBooking({
    channel: 'DIRECT', room_type_id: 'rt1', rate_plan_id: 'rp1',
    arrival: '2026-08-01', departure: '2026-08-03',
    adults: 2, currency: 'USD'
  }, CTX);

  assert.equal(r.ok, true, 'booking should succeed with ARI-computed availability + rate');
  assert.ok(r.pricing.total > 0, 'pricing total should be positive');
  assert.equal(adjCalls.length, 1, 'adjustSold should have been called once');
  assert.equal(adjCalls[0].delta, 1);
});

// ---- Backward compat: no ariService -> flat rateResolver path ---------------

test('Backward compat: buildBookingEngine without ariService uses flat base_rate path', async () => {
  const bus = fakeCommandBus();
  const eng = buildBookingEngine({
    commandBus: bus,
    availabilityProvider: () => 5  // explicit provider so availability isn't the blocker
  });

  const r = await eng.service.createBooking({
    channel: 'DIRECT', room_type_id: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03',
    adults: 2, base_rate: 100, currency: 'USD'
  }, CTX);

  assert.equal(r.ok, true);
  // 100 * 2 nights = 200 + 15% tax = 230
  assert.equal(r.pricing.total, 230);
});

test('Backward compat: no inventoryAdjuster injected -> no-op, booking still succeeds', async () => {
  const bus = fakeCommandBus();
  // No inventoryAdjuster in options bag
  const eng = buildBookingEngine({
    commandBus: bus,
    availabilityProvider: () => 5
  });

  const r = await eng.service.createBooking({
    channel: 'DIRECT', room_type_id: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03',
    adults: 2, base_rate: 100, currency: 'USD'
  }, CTX);

  assert.equal(r.ok, true);
  assert.ok(r.pricing.total > 0);
});

// ---- ariInventoryAdjuster: night loop correctness ---------------------------

test('ariInventoryAdjuster: iterates each night in [arrival, departure) and calls adjustSold per night', async () => {
  const adjCalls = [];
  const fakeStore = {
    async adjustSold(args) { adjCalls.push({ ...args }); return { sold: 1, version: 1 }; }
  };

  const adjuster = buildAriInventoryAdjuster({ ariStore: fakeStore });
  await adjuster.adjustSold({
    tenantId: 't1', propertyId: 'p1', roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-04', // 3 nights
    delta: 1
  });

  assert.equal(adjCalls.length, 3, 'should call adjustSold for each of the 3 nights');
  assert.equal(adjCalls[0].date, '2026-08-01');
  assert.equal(adjCalls[1].date, '2026-08-02');
  assert.equal(adjCalls[2].date, '2026-08-03');
  assert.ok(adjCalls.every((c) => c.delta === 1));
});

test('ariInventoryAdjuster: null return per night (floor guard) is logged but does not throw', async () => {
  const fakeStore = {
    async adjustSold() { return null; } // floor guard
  };

  const adjuster = buildAriInventoryAdjuster({ ariStore: fakeStore });
  // Must not throw
  await assert.doesNotReject(() => adjuster.adjustSold({
    tenantId: 't1', propertyId: 'p1', roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03',
    delta: -1
  }));
});
