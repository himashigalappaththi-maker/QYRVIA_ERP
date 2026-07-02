import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canConfirm, canCancel, canNoShow, canCheckIn, canCheckOut,
  deriveArrivals, deriveDepartures, deriveInHouse, countByStatus, buildReservationPayload
} from '../src/modules/frontdesk/logic.js';

const rows = [
  { id: '1', status: 'CONFIRMED', arrival_date: '2026-06-23', departure_date: '2026-06-25' },
  { id: '2', status: 'CONFIRMED', arrival_date: '2026-06-24', departure_date: '2026-06-26' },
  { id: '3', status: 'CHECKED_IN', arrival_date: '2026-06-22', departure_date: '2026-06-23' },
  { id: '4', status: 'CHECKED_IN', arrival_date: '2026-06-20', departure_date: '2026-06-28' },
  { id: '5', status: 'INQUIRY', arrival_date: '2026-06-23', departure_date: '2026-06-24' }
];

test('lifecycle guards mirror backend transitions', () => {
  assert.equal(canConfirm({ status: 'INQUIRY' }), true);
  assert.equal(canConfirm({ status: 'CONFIRMED' }), false);
  assert.equal(canCancel({ status: 'CONFIRMED' }), true);
  assert.equal(canCancel({ status: 'CHECKED_IN' }), false);
  assert.equal(canNoShow({ status: 'CONFIRMED' }), true);
  assert.equal(canNoShow({ status: 'INQUIRY' }), false);
  assert.equal(canCheckIn({ status: 'CONFIRMED' }), true);
  assert.equal(canCheckIn({ status: 'INQUIRY' }), false);
  assert.equal(canCheckOut({ status: 'CHECKED_IN' }), true);
  assert.equal(canCheckOut({ status: 'CONFIRMED' }), false);
});

test('derive arrivals / departures / in-house', () => {
  const today = '2026-06-23';
  assert.deepEqual(deriveArrivals(rows, today).map((r) => r.id), ['1']);       // confirmed, arrival <= today
  assert.deepEqual(deriveDepartures(rows, today).map((r) => r.id), ['3']);     // in-house, departure <= today
  assert.deepEqual(deriveInHouse(rows).map((r) => r.id), ['3', '4']);
});

test('countByStatus tallies', () => {
  const c = countByStatus(rows);
  assert.equal(c.CONFIRMED, 2);
  assert.equal(c.CHECKED_IN, 2);
  assert.equal(c.INQUIRY, 1);
});

test('buildReservationPayload validates + maps', () => {
  const bad = buildReservationPayload({ holder_guest_id: 'g1' });
  assert.equal(bad.ok, false);

  const badDates = buildReservationPayload({ holder_guest_id: 'g1', primary_adult_guest_id: 'g1', room_type_id: 'rt', arrival_date: '2026-07-05', departure_date: '2026-07-05' });
  assert.equal(badDates.ok, false);

  const okp = buildReservationPayload({
    holder_guest_id: 'g1', primary_adult_guest_id: 'g2', room_type_id: 'rt1',
    arrival_date: '2026-07-01', departure_date: '2026-07-04', adults: '2', children: '1',
    rate_plan_id: 'rp1', notes: 'late arrival'
  });
  assert.equal(okp.ok, true);
  assert.equal(okp.payload.adults, 2);
  assert.equal(okp.payload.children, 1);
  assert.equal(okp.payload.reservation_type, 'INDIVIDUAL');
  assert.equal(okp.payload.rate_plan_id, 'rp1');
});
