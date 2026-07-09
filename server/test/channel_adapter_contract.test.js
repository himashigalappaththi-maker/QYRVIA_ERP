'use strict';

/** Phase 10.0 - every adapter (present + future) must satisfy the contract. */

// Env sentinels before requiring app modules (BookingComAdapter -> logger -> env).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assertImplements } = require('../src/channel-manager/adapters/base/OTAAdapter');
const { BookingComAdapter } = require('../src/channel-manager/adapters/bookingcom/BookingComAdapter');
const { QTCNAdapter } = require('../src/channel-manager/adapters/qyrcn/QTCNAdapter');
const { AgodaAdapter } = require('../src/channel-manager/adapters/agoda/AgodaAdapter');
const { ExpediaAdapter } = require('../src/channel-manager/adapters/expedia/ExpediaAdapter');
const { AirbnbAdapter } = require('../src/channel-manager/adapters/airbnb/AirbnbAdapter');
const { MOCK_BOOKINGS } = require('../src/channel-manager/adapters/bookingcom/bookingcom.mock');
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');

const ALL = [new BookingComAdapter(), new QTCNAdapter(), new AgodaAdapter(), new ExpediaAdapter(), new AirbnbAdapter()];

test('every adapter satisfies the OTAAdapter contract', () => {
  for (const a of ALL) {
    const check = assertImplements(a);
    assert.ok(check.ok, a.channel + ' missing: ' + check.missing.join(','));
    assert.ok(a.channel, 'channel set');
  }
});

test('Booking.com mock pulls + maps to canonical', async () => {
  const a = new BookingComAdapter();
  const raw = await a.pullBookings();
  assert.equal(raw.length, MOCK_BOOKINGS.length);
  const canon = a.mapToCanonical(raw[0]);
  assert.equal(canon.channel, CHANNELS.BOOKING_COM);
  assert.equal(canon.bookingId, 'BC-123');
  assert.equal(canon.status, 'CONFIRMED');
});

test('QYRVIA_CONNECT (QTCNAdapter) is a QYRVIA-owned OTA (15% adapter commission, no privilege)', () => {
  const q = new QTCNAdapter();
  assert.equal(q.internal, undefined, 'QYRVIA_CONNECT adapter has no internal flag — use qyrvia_owned in defaultChannels.js');
  assert.equal(q.qyrvia_owned, undefined, 'QYRVIA_CONNECT adapter has no qyrvia_owned — that is a registry/seeding concern only');
  assert.equal(q.commissionPct, 15);
  const c = q.mapToCanonical({ id: 'Q1', guestName: 'Direct', propertyId: 'p', roomTypeId: 'rt' });
  assert.equal(c.channel, CHANNELS.QYRVIA_CONNECT);
  assert.equal(c.commissionPct, 15);
});

test('stub adapters expose the contract but throw on network ops', async () => {
  const a = new AgodaAdapter();
  assert.equal(assertImplements(a).ok, true);
  await assert.rejects(() => a.pushRates({}), /not_implemented/);
  await assert.rejects(() => a.pullBookings(), /not_implemented/);
});
