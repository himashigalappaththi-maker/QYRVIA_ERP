'use strict';

/**
 * Phase 10.2 - OTA scaling system: contract validation, registry/factory load,
 * and identical Booking.com vs QTCN behavior (QTCN is just another OTA).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/channel-manager/registry/adapterRegistry');
const factory = require('../src/channel-manager/registry/adapterFactory');
const { REQUIRED_METHODS, assertAdapter } = require('../src/channel-manager/adapters/base/assertAdapter');

const EXPECTED = ['agoda', 'airbnb', 'booking.com', 'expedia', 'googletravel', 'makemytrip', 'qytn', 'tripadvisor'];

test('registry auto-discovers all OTA adapters from the filesystem', () => {
  const names = registry.list();
  assert.ok(names.length >= 7, 'expected 7+ adapters, got ' + names.length);
  for (const n of EXPECTED) assert.ok(names.includes(n), 'missing adapter: ' + n);
  assert.ok(names.includes('qytn'), 'QTCN must be a normal registered OTA');
});

test('every adapter satisfies the 5-method async contract', () => {
  for (const v of registry.validateAll()) {
    assert.ok(v.ok, v.name + ' non-compliant: missing=' + v.missing + ' notAsync=' + v.notAsync);
  }
  // and the contract really is the 5 scaling methods
  assert.deepEqual(REQUIRED_METHODS, ['pullAvailability', 'pushRates', 'pushInventory', 'createBooking', 'cancelBooking']);
});

test('registry.get returns instances; unknown name throws', () => {
  const a = registry.get('agoda');
  assert.equal(a.channel, 'agoda');
  assert.equal(assertAdapter(a).ok, true);
  assert.throws(() => registry.get('does.not.exist'), /unknown_ota/);
});

test('factory lazy-loads and caches (same instance returned)', () => {
  factory.clearCache();
  const a = registry.get('expedia');
  const b = registry.get('expedia');
  assert.equal(a, b, 'factory should cache the instance');
});

test('mock booking flow is identical for Booking.com and QTCN (no privilege/bypass)', async () => {
  const bcom = registry.get('booking.com');
  const qytn = registry.get('qytn');
  const req = { ref: 'R1', guestName: 'G', propertyId: 'p', roomTypeId: 'rt', amount: 100, currency: 'USD' };

  const b1 = await bcom.createBooking(req);
  const b2 = await qytn.createBooking(req);
  assert.equal(b1.status, 'CONFIRMED');
  assert.equal(b2.status, 'CONFIRMED');
  assert.equal(b1.bookingId, 'booking.com:R1');
  assert.equal(b2.bookingId, 'qytn:R1');
  // Identical behavior pattern: same result shape.
  assert.deepEqual(Object.keys(b1).sort(), Object.keys(b2).sort());
  // Only difference is data (commission), not behavior.
  assert.equal(b1.commissionPct, 15);
  assert.equal(b2.commissionPct, 0);

  const c1 = await bcom.cancelBooking('X9');
  const c2 = await qytn.cancelBooking('X9');
  assert.equal(c1.status, 'CANCELLED');
  assert.equal(c2.status, 'CANCELLED');
  assert.deepEqual(Object.keys(c1).sort(), Object.keys(c2).sort());

  const av1 = await bcom.pullAvailability({ propertyId: 'p', date: '2026-07-01', available: 3 });
  const av2 = await qytn.pullAvailability({ propertyId: 'p', date: '2026-07-01', available: 3 });
  assert.equal(av1[0].available, 3);
  assert.deepEqual(Object.keys(av1[0]).sort(), Object.keys(av2[0]).sort());

  const r1 = await bcom.pushRates({ date: '2026-07-01', amount: 100 });
  assert.equal(r1.ok, true);
  assert.equal(r1.channel, 'booking.com');
  const i1 = await qytn.pushInventory({ date: '2026-07-01', available: 5 });
  assert.equal(i1.ok, true);
  assert.equal(i1.op, 'pushInventory');
});

test('QTCN exposes exactly the same method surface as an external OTA', () => {
  const bcom = registry.get('booking.com');
  const qytn = registry.get('qytn');
  for (const m of REQUIRED_METHODS) {
    assert.equal(typeof bcom[m], 'function');
    assert.equal(typeof qytn[m], 'function');
  }
  // no extra privileged method on QTCN
  const extra = Object.getOwnPropertyNames(Object.getPrototypeOf(qytn))
    .filter((n) => n !== 'constructor' && typeof qytn[n] === 'function');
  assert.deepEqual(extra.sort(), [].sort(), 'QTCN should add no methods beyond the shared base');
});
