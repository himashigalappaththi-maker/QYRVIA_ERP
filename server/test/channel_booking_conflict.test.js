'use strict';

/** Phase 10.0 - booking conflict resolution. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingService } = require('../src/channel-manager/services/BookingService');
const { makeCanonicalBooking } = require('../src/channel-manager/core/canonical/CanonicalBooking');
const { CHANNELS } = require('../src/channel-manager/core/canonical/types');

const slot = { propertyId: 'p1', roomTypeId: 'rt1', arrival: '2026-07-01', departure: '2026-07-03' };
const mk = (id, channel, status) => makeCanonicalBooking(Object.assign({ bookingId: id, channel, status }, slot));

test('no OTA has priority: QTCN does not win over an incumbent OTA on the same slot', () => {
  const svc = buildBookingService();
  svc.ingest(mk('BC-1', CHANNELS.BOOKING_COM, 'CONFIRMED'));
  const res = svc.ingest(mk('Q-1', CHANNELS.QTCN, 'CONFIRMED'));
  assert.ok(res.conflict, 'conflict detected');
  // QTCN is just another OTA - the incumbent is retained, no channel favoritism.
  assert.equal(res.conflict.winner, 'BC-1');
  assert.equal(res.conflict.reason, 'incumbent_retained');
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

// Phase 37 WI-1: a second CONFIRMED booking on an already-CONFIRMED slot must be flagged as a
// conflict (incumbent retained) - the channel layer never silently double-books a physical slot.
test('WI-1: a second CONFIRMED booking on an occupied slot is flagged, incumbent retained (no double-book)', () => {
  const svc = buildBookingService();
  svc.ingest(mk('EX-9', CHANNELS.EXPEDIA, 'CONFIRMED'));
  const res = svc.ingest(mk('BC-9', CHANNELS.BOOKING_COM, 'CONFIRMED')); // races the same slot
  assert.ok(res.conflict, 'the second CONFIRMED booking on the same slot raises a conflict');
  assert.equal(res.conflict.winner, 'EX-9', 'the incumbent slot holder is retained');
  assert.equal(res.conflict.reason, 'incumbent_retained');
  assert.equal(svc.conflicts().length, 1, 'the conflict is recorded for reconciliation, not dropped');
});
