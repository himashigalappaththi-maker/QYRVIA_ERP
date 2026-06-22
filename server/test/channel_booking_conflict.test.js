'use strict';

/** Phase 10.0 - booking conflict resolution. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingService } = require('../src/channel-manager/services/BookingService');
const { makeCanonicalBooking } = require('../src/channel-manager/core/canonical/CanonicalBooking');
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');

const slot = { propertyId: 'p1', roomTypeId: 'rt1', arrival: '2026-07-01', departure: '2026-07-03' };
const mk = (id, channel, status) => makeCanonicalBooking(Object.assign({ bookingId: id, channel, status }, slot));

test('QTCN wins a same-slot conflict against an OTA (protect direct revenue)', () => {
  const svc = buildBookingService();
  svc.ingest(mk('BC-1', CHANNELS.BOOKING_COM, 'CONFIRMED'));
  const res = svc.ingest(mk('Q-1', CHANNELS.QTCN, 'CONFIRMED'));
  assert.ok(res.conflict, 'conflict detected');
  assert.equal(res.conflict.winnerChannel, CHANNELS.QTCN);
  assert.equal(res.conflict.reason, 'qtcn_priority');
});

test('idempotent ingest: same booking + status is deduped', () => {
  const svc = buildBookingService();
  svc.ingest(mk('BC-2', CHANNELS.BOOKING_COM, 'CONFIRMED'));
  const again = svc.ingest(mk('BC-2', CHANNELS.BOOKING_COM, 'CONFIRMED'));
  assert.equal(again.action, 'deduped');
  assert.equal(svc.count(), 1);
});

test('CONFIRMED beats PENDING when neither is QTCN', () => {
  const svc = buildBookingService();
  svc.ingest(mk('BC-3', CHANNELS.BOOKING_COM, 'CONFIRMED'));
  const res = svc.ingest(mk('EX-3', CHANNELS.EXPEDIA, 'CONFIRMED'));   // both confirmed -> incumbent retained
  assert.ok(res.conflict);
  assert.equal(res.conflict.winner, 'BC-3');
  assert.equal(res.conflict.reason, 'incumbent_retained');
});

test('no conflict when slots differ', () => {
  const svc = buildBookingService();
  svc.ingest(mk('BC-4', CHANNELS.BOOKING_COM, 'CONFIRMED'));
  const other = makeCanonicalBooking({ bookingId: 'BC-5', channel: CHANNELS.BOOKING_COM, status: 'CONFIRMED',
    propertyId: 'p1', roomTypeId: 'rt1', arrival: '2026-08-01', departure: '2026-08-02' });
  const res = svc.ingest(other);
  assert.equal(res.conflict, null);
});
