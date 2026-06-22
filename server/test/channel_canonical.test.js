'use strict';

/** Phase 10.0 - canonical model validation. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeCanonicalBooking } = require('../src/channel-manager/core/canonical/CanonicalBooking');
const { makeCanonicalRate } = require('../src/channel-manager/core/canonical/CanonicalRate');
const { makeCanonicalInventory } = require('../src/channel-manager/core/canonical/CanonicalInventory');
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');

test('CanonicalBooking: valid, frozen, normalized', () => {
  const b = makeCanonicalBooking({ bookingId: 'X1', channel: CHANNELS.BOOKING_COM, status: 'CONFIRMED', amount: '120' });
  assert.equal(b.bookingId, 'X1');
  assert.equal(b.channel, 'BOOKING_COM');
  assert.equal(b.amount, 120);
  assert.ok(Object.isFrozen(b));
});

test('CanonicalBooking: rejects missing id and invalid channel/status', () => {
  assert.throws(() => makeCanonicalBooking({ channel: CHANNELS.AGODA }), /bookingId required/);
  assert.throws(() => makeCanonicalBooking({ bookingId: 'Y', channel: 'NOPE' }), /invalid channel/);
  assert.throws(() => makeCanonicalBooking({ bookingId: 'Y', channel: CHANNELS.AGODA, status: 'WAT' }), /invalid status/);
});

test('CanonicalRate: requires date + non-negative amount', () => {
  const r = makeCanonicalRate({ propertyId: 'p', roomTypeId: 'rt', date: '2026-07-01', amount: 99.5 });
  assert.equal(r.amount, 99.5);
  assert.equal(r.ratePlanId, 'STD');
  assert.throws(() => makeCanonicalRate({ propertyId: 'p', roomTypeId: 'rt', amount: 10 }), /date required/);
  assert.throws(() => makeCanonicalRate({ propertyId: 'p', roomTypeId: 'rt', date: '2026-07-01', amount: -1 }), /amount must be/);
});

test('CanonicalInventory: rejects non-integer / negative availability', () => {
  const i = makeCanonicalInventory({ propertyId: 'p', roomTypeId: 'rt', date: '2026-07-01', available: 3 });
  assert.equal(i.available, 3);
  assert.equal(i.stopSell, false);
  assert.throws(() => makeCanonicalInventory({ propertyId: 'p', roomTypeId: 'rt', date: '2026-07-01', available: 2.5 }), /non-negative integer/);
  assert.throws(() => makeCanonicalInventory({ propertyId: 'p', roomTypeId: 'rt', date: '2026-07-01', available: -1 }), /non-negative integer/);
});
