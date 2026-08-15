'use strict';

/**
 * Phase 68A — pure ARI envelope -> Booking.com codec input mapping.
 * No I/O, no PostgreSQL, no network — src/ari/dispatch/ariRateMapping.js is
 * a pure function module by construction.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mapAriEnvelope, mapInventoryChanged, mapRateChanged, isSingleDayRange } = require('../src/ari/dispatch/ariRateMapping');
const { bookingcom } = require('../src/channel-manager/ota/providers/bookingcom');

const BASE = {
  id: 'ev1', tenantId: 't1', propertyId: 'p1', roomTypeId: 'rt1', ratePlanId: null,
  dedupeKey: 'aob:v1:x', sourceVersion: 3
};
const MAPPING = { otaPropertyId: 'HOTEL-1', otaRoomId: 'OTA-ROOM-1', otaRatePlanId: 'OTA-PLAN-1' };

test('isSingleDayRange: true for [d, d+1), false for anything wider or undated', () => {
  assert.equal(isSingleDayRange('2026-08-01', '2026-08-02'), true);
  assert.equal(isSingleDayRange('2026-08-01', '2026-08-03'), false);
  assert.equal(isSingleDayRange('2026-01-01', '2099-12-31'), false, 'sentinel/config window is not a single day');
  assert.equal(isSingleDayRange(null, null), false);
});

// ---- N/P. INVENTORY_CHANGED --------------------------------------------

test('N/P. INVENTORY_CHANGED with authoritative physical/sold/blocked derives available (never fabricated)', () => {
  const envelope = Object.assign({}, BASE, {
    eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { date: '2026-08-01', physical: 10, sold: 3, blocked: 2, stopSell: false }
  });
  const mapped = mapAriEnvelope(envelope, MAPPING);
  assert.equal(mapped.operation, 'AVAILABILITY');
  assert.equal(mapped.input.hotelCode, 'HOTEL-1');
  assert.equal(mapped.input.otaRoomId, 'OTA-ROOM-1');
  assert.equal(mapped.input.date, '2026-08-01');
  assert.equal(mapped.input.available, 5); // 10 - 3 - 2
  assert.equal(mapped.input.stop_sell, false);

  // Feed straight into the real Booking.com codec to prove end-to-end shape compatibility.
  const wire = bookingcom.encodeAvailability(mapped.input);
  assert.equal(wire.availability[0].rooms_to_sell, 5);
  assert.equal(wire.availability[0].room_id, 'OTA-ROOM-1');
});

test('available is floored at 0, never negative, when sold+blocked exceeds physical', () => {
  const envelope = Object.assign({}, BASE, {
    eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { date: '2026-08-01', physical: 5, sold: 4, blocked: 3, stopSell: false }
  });
  assert.equal(mapAriEnvelope(envelope, MAPPING).input.available, 0);
});

test('an adjustSold-shaped INVENTORY_CHANGED payload (no physical/blocked) FAILS CLOSED rather than fabricating available', () => {
  const envelope = Object.assign({}, BASE, {
    eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { date: '2026-08-01', delta: -1, sold: 4, source: 'ari_api' }
  });
  assert.throws(() => mapAriEnvelope(envelope, MAPPING), (e) => e.code === 'ARI_MAPPING_INCOMPLETE_INVENTORY' && e.retryable === false);
});

// ---- O/Q. RATE_CHANGED ---------------------------------------------------

test('O/Q. RATE_CHANGED with a resolved single-date amount maps rate + CTA/CTD/minLOS/maxLOS', () => {
  const envelope = Object.assign({}, BASE, {
    ratePlanId: 'rp1',
    eventType: 'RATE_CHANGED', resourceKind: 'RATE',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { rate: 150, currency: 'USD', cta: true, ctd: false, minLos: 2, maxLos: 7 }
  });
  const mapped = mapAriEnvelope(envelope, MAPPING);
  assert.equal(mapped.operation, 'RATE');
  assert.equal(mapped.input.rate, 150);
  assert.equal(mapped.input.currency, 'USD');
  assert.equal(mapped.input.otaRatePlanId, 'OTA-PLAN-1');
  assert.deepEqual(mapped.input.restrictions, { cta: true, ctd: false, min_los: 2, max_los: 7 });

  const wire = bookingcom.encodeRateUpdate(mapped.input);
  assert.equal(wire.ari[0].rate.amount, 150);
  assert.equal(wire.ari[0].restrictions.closed_to_arrival, true);
  assert.equal(wire.ari[0].restrictions.min_length_of_stay, 2);
});

test('baseRate is accepted when rate is absent (undated-config-style payload key), still requires a single-day range', () => {
  const envelope = Object.assign({}, BASE, {
    eventType: 'RATE_CHANGED', resourceKind: 'RATE',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { baseRate: 99, currency: 'USD' }
  });
  assert.equal(mapAriEnvelope(envelope, MAPPING).input.rate, 99);
});

test('RATE_CHANGED over the undated sentinel/config window FAILS CLOSED — never fabricates a date', () => {
  const envelope = Object.assign({}, BASE, {
    eventType: 'RATE_CHANGED', resourceKind: 'RATE',
    effectiveFrom: '1970-01-01', effectiveTo: '9999-12-31',
    payload: { baseRate: 99, currency: 'USD' }
  });
  assert.throws(() => mapAriEnvelope(envelope, MAPPING), (e) => e.code === 'ARI_MAPPING_UNSUPPORTED_RANGE' && e.retryable === false);
});

test('RATE_CHANGED with no resolvable rate amount FAILS CLOSED rather than sending zero/undefined', () => {
  const envelope = Object.assign({}, BASE, {
    eventType: 'RATE_CHANGED', resourceKind: 'RATE',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { currency: 'USD' }
  });
  assert.throws(() => mapAriEnvelope(envelope, MAPPING), (e) => e.code === 'ARI_MAPPING_MISSING_RATE_AMOUNT');
});

// ---- L/M. missing mapping fails closed -----------------------------------

test('L. a missing room mapping (no otaRoomId) fails closed and never assumes roomTypeId == otaRoomId', () => {
  const envelope = Object.assign({}, BASE, {
    eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { date: '2026-08-01', physical: 10, sold: 0, blocked: 0, stopSell: false }
  });
  assert.throws(() => mapAriEnvelope(envelope, { otaPropertyId: 'HOTEL-1' }), (e) => e.code === 'ARI_MAPPING_MISSING_ROOM');
  assert.throws(() => mapAriEnvelope(envelope, null), (e) => e.code === 'ARI_MAPPING_MISSING');
});

test('M. a missing rate-plan mapping (envelope carries a ratePlanId but mapping has none) fails closed', () => {
  const envelope = Object.assign({}, BASE, {
    ratePlanId: 'rp1',
    eventType: 'RATE_CHANGED', resourceKind: 'RATE',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { rate: 100, currency: 'USD' }
  });
  assert.throws(
    () => mapAriEnvelope(envelope, { otaPropertyId: 'HOTEL-1', otaRoomId: 'OTA-ROOM-1' /* no otaRatePlanId */ }),
    (e) => e.code === 'ARI_MAPPING_MISSING_RATE_PLAN'
  );
});

test('a property-level RATE_CHANGED (ratePlanId null) does NOT require a rate-plan mapping', () => {
  const envelope = Object.assign({}, BASE, {
    ratePlanId: null,
    eventType: 'RATE_CHANGED', resourceKind: 'RATE',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { rate: 100, currency: 'USD' }
  });
  const mapped = mapAriEnvelope(envelope, { otaPropertyId: 'HOTEL-1', otaRoomId: 'OTA-ROOM-1' });
  assert.equal(mapped.input.rate, 100);
});

// ---- AVAILABILITY_CHANGED (restriction-rule / room-config) is refused, not silently dropped ----

test('AVAILABILITY_CHANGED (restriction-rule or room-config) is explicitly UNSUPPORTED, never silently mapped to a guessed value', () => {
  const envelope = Object.assign({}, BASE, {
    eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY',
    effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02',
    payload: { cta: true, ctd: false, minLos: 2, maxLos: null, restrictionRuleId: 'r1', level: 'property' }
  });
  assert.throws(() => mapAriEnvelope(envelope, MAPPING), (e) => e.code === 'ARI_MAPPING_UNSUPPORTED_EVENT' && e.retryable === false);
});

test('an unrecognised eventType fails closed', () => {
  const envelope = Object.assign({}, BASE, { eventType: 'SOMETHING_ELSE', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', payload: {} });
  assert.throws(() => mapAriEnvelope(envelope, MAPPING), (e) => e.code === 'ARI_MAPPING_UNKNOWN_EVENT_TYPE');
});
