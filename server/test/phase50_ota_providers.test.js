'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { agoda }       = require('../src/channel-manager/ota/providers/agoda');
const { airbnb }      = require('../src/channel-manager/ota/providers/airbnb');
const { makemytrip }  = require('../src/channel-manager/ota/providers/makemytrip');
const { google }      = require('../src/channel-manager/ota/providers/google');
const { tripadvisor } = require('../src/channel-manager/ota/providers/tripadvisor');
const { CHANNELS }    = require('../src/channel-manager/core/canonical/types');

const RATE = { date: '2026-08-01', rate: 120, currency: 'USD', roomTypeId: 'STD', ratePlanId: 'BAR', otaPropertyId: 'H1', restrictions: { minLos: 2, cta: false, ctd: false } };
const INV  = { date: '2026-08-01', available: 5, stopSell: false, roomTypeId: 'STD', otaPropertyId: 'H1' };
const RES  = { bookingId: 'BK-99', status: 'CONFIRMED', hotelCode: 'H1' };

// — Channel codes —
test('all new providers expose the correct CHANNELS code', () => {
  assert.equal(agoda.channel,       CHANNELS.AGODA);
  assert.equal(airbnb.channel,      CHANNELS.AIRBNB);
  assert.equal(makemytrip.channel,  CHANNELS.MAKEMYTRIP);
  assert.equal(google.channel,      CHANNELS.GOOGLE);
  assert.equal(tripadvisor.channel, CHANNELS.TRIPADVISOR);
});

// — authToHeaders —
test('agoda: authToHeaders maps api_key to Authorization Token', () => {
  const h = agoda.authToHeaders({ api_key: 'k1' });
  assert.equal(h['Authorization'], 'Token k1');
});
test('agoda: authToHeaders maps token to Bearer', () => {
  const h = agoda.authToHeaders({ token: 'tok' });
  assert.equal(h['Authorization'], 'Bearer tok');
});
test('agoda: authToHeaders returns {} on null', () => {
  assert.deepEqual(agoda.authToHeaders(null), {});
});

test('airbnb: authToHeaders maps access_token to Bearer', () => {
  const h = airbnb.authToHeaders({ access_token: 'at1' });
  assert.equal(h['Authorization'], 'Bearer at1');
});
test('airbnb: authToHeaders maps api_key to X-Airbnb-API-Key', () => {
  const h = airbnb.authToHeaders({ api_key: 'ak' });
  assert.equal(h['X-Airbnb-API-Key'], 'ak');
});

test('makemytrip: authToHeaders maps api_key + api_secret to dual headers', () => {
  const h = makemytrip.authToHeaders({ api_key: 'k', api_secret: 's' });
  assert.equal(h['X-MMT-API-Key'], 'k');
  assert.equal(h['X-MMT-API-Secret'], 's');
});
test('makemytrip: authToHeaders maps api_key alone', () => {
  const h = makemytrip.authToHeaders({ api_key: 'k' });
  assert.equal(h['X-MMT-API-Key'], 'k');
  assert.ok(!h['X-MMT-API-Secret']);
});

test('google: authToHeaders maps access_token to Bearer', () => {
  const h = google.authToHeaders({ access_token: 'gat' });
  assert.equal(h['Authorization'], 'Bearer gat');
});
test('google: authToHeaders maps api_key to X-Goog-Api-Key', () => {
  const h = google.authToHeaders({ api_key: 'gk' });
  assert.equal(h['X-Goog-Api-Key'], 'gk');
});

test('tripadvisor: authToHeaders maps api_key to X-TripAdvisor-API-Key', () => {
  const h = tripadvisor.authToHeaders({ api_key: 'ta1' });
  assert.equal(h['X-TripAdvisor-API-Key'], 'ta1');
});
test('tripadvisor: authToHeaders maps token to Bearer', () => {
  const h = tripadvisor.authToHeaders({ token: 'tok' });
  assert.equal(h['Authorization'], 'Bearer tok');
});

// — encodeRateUpdate —
test('agoda encodeRateUpdate includes hotel_id, room_type_id, sell_rate', () => {
  const e = agoda.encodeRateUpdate(RATE);
  assert.equal(e.hotel_id, 'H1');
  assert.equal(e.room_type_id, 'STD');
  assert.equal(e.sell_rate, 120);
  assert.equal(e.currency, 'USD');
  assert.equal(e.min_stay, 2);
});

test('airbnb encodeRateUpdate includes listing_id and pricing_rules', () => {
  const e = airbnb.encodeRateUpdate(RATE);
  assert.equal(e.listing_id, 'H1');
  assert.ok(Array.isArray(e.pricing_rules) && e.pricing_rules.length === 1);
  assert.equal(e.pricing_rules[0].price, 120);
});

test('makemytrip encodeRateUpdate includes hotel_code and dates array', () => {
  const e = makemytrip.encodeRateUpdate(RATE);
  assert.equal(e.hotel_code, 'H1');
  assert.ok(Array.isArray(e.dates) && e.dates.length === 1);
  assert.equal(e.dates[0].rate, 120);
  assert.equal(e.dates[0].min_los, 2);
});

test('google encodeRateUpdate includes hotel_id and itinerary', () => {
  const e = google.encodeRateUpdate(RATE);
  assert.equal(e.hotel_id, 'H1');
  assert.ok(e.itinerary);
  assert.equal(e.itinerary.rate.value, 120);
});

test('tripadvisor encodeRateUpdate includes property_id and dates', () => {
  const e = tripadvisor.encodeRateUpdate(RATE);
  assert.equal(e.property_id, 'H1');
  assert.ok(Array.isArray(e.dates) && e.dates.length === 1);
  assert.equal(e.dates[0].rate.amount, 120);
});

// — encodeAvailability —
test('agoda encodeAvailability sets allotment and stop_sell', () => {
  const e = agoda.encodeAvailability(INV);
  assert.equal(e.allotment, 5);
  assert.equal(e.stop_sell, false);
});

test('airbnb encodeAvailability: stop_sell=true → available=false', () => {
  const e = airbnb.encodeAvailability({ ...INV, stopSell: true });
  assert.equal(e.calendar[0].available, false);
});

test('makemytrip encodeAvailability wraps in dates array', () => {
  const e = makemytrip.encodeAvailability(INV);
  assert.equal(e.dates[0].available, 5);
});

test('google encodeAvailability includes room_count', () => {
  const e = google.encodeAvailability(INV);
  assert.equal(e.room_count, 5);
});

test('tripadvisor encodeAvailability wraps in dates array', () => {
  const e = tripadvisor.encodeAvailability(INV);
  assert.equal(e.dates[0].rooms, 5);
});

// — decodeAck: transport_disabled is non-retryable —
const DISABLED_RAW = { error: 'transport_disabled', ok: false, status: 0, body: null };
for (const [name, prov] of [['agoda', agoda], ['airbnb', airbnb], ['makemytrip', makemytrip], ['google', google], ['tripadvisor', tripadvisor]]) {
  test(`${name} decodeAck: transport_disabled is non-retryable`, () => {
    const ack = prov.decodeAck('pushRateUpdate', DISABLED_RAW);
    assert.equal(ack.ok, false);
    assert.equal(ack.retryable, false);
    assert.equal(ack.errors[0].code, 'transport_disabled');
  });
  test(`${name} decodeAck: 200 is ok`, () => {
    const ack = prov.decodeAck('pushRateUpdate', { ok: true, status: 200, body: {} });
    assert.equal(ack.ok, true);
  });
  test(`${name} decodeAck: 500 is retryable`, () => {
    const ack = prov.decodeAck('pushRateUpdate', { ok: false, status: 500, body: {} });
    assert.equal(ack.retryable, true);
  });
  test(`${name} decodeAck: 400 is not retryable`, () => {
    const ack = prov.decodeAck('pushRateUpdate', { ok: false, status: 400, body: {} });
    assert.equal(ack.retryable, false);
  });
}

// — providers index lists all 7 channels —
test('providers index exports all 7 OTA channels', () => {
  const { listProviders, hasProvider } = require('../src/channel-manager/ota/providers');
  const list = listProviders();
  for (const ch of [CHANNELS.BOOKING_COM, CHANNELS.EXPEDIA, CHANNELS.AGODA, CHANNELS.AIRBNB, CHANNELS.MAKEMYTRIP, CHANNELS.GOOGLE, CHANNELS.TRIPADVISOR]) {
    assert.ok(hasProvider(ch), `missing provider for ${ch}`);
  }
  assert.ok(list.length >= 7);
});
