'use strict';

/** Phase 10.1 - QTCN routing engine (pure) + decision model + CM bridge. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decide } = require('../src/qytn/core/qytnEngine');
const { makeDecision } = require('../src/qytn/models/qytnDecision');
const { buildChannelManagerBridge } = require('../src/qytn/integrations/channelManagerBridge');
const { buildPmsBridge } = require('../src/qytn/integrations/pmsBridge');

const ALL = { availableChannels: ['QTCN', 'booking.com', 'agoda', 'expedia', 'airbnb', 'makemytrip', 'google.travel', 'tripadvisor'] };

test('rule 1: explicit direct request -> DIRECT/QTCN with confidence 1', () => {
  const d = decide({ request: { directRequest: true }, snapshot: ALL });
  assert.equal(d.route, 'DIRECT');
  assert.equal(d.selectedChannel, 'QTCN');
  assert.equal(d.confidenceScore, 1);
  assert.ok(d.fallbackChain.length > 0);
});

test('rule 5: default routes to lowest-cost OTA (google.travel @12%)', () => {
  const d = decide({ request: { guestCancellationRate: 0, leadTimeDays: 5, refundable: false }, snapshot: ALL });
  assert.equal(d.route, 'OTA');
  assert.equal(d.selectedChannel, 'google.travel');
  assert.equal(d.fallbackChain[0], 'QTCN');
});

test('rule 2: cheapest available OTA commission > 18% prefers QTCN direct', () => {
  const d = decide({ request: {}, snapshot: { availableChannels: ['QTCN', 'expedia'] } }); // expedia 20%
  assert.equal(d.route, 'DIRECT');
  assert.equal(d.selectedChannel, 'QTCN');
  assert.ok(d.reasoning.some((r) => /commission/.test(r)));
});

test('boundary: commission exactly 18% (agoda) is NOT > 18 -> stays OTA', () => {
  const d = decide({ request: {}, snapshot: { availableChannels: ['QTCN', 'agoda'] } });
  assert.equal(d.route, 'OTA');
  assert.equal(d.selectedChannel, 'agoda');
});

test('rule 3: inventory mismatch risk over threshold -> QTCN fallback', () => {
  const snap = { availableChannels: ['QTCN', 'booking.com'],
    channelAvailability: { 'booking.com': { pmsCount: 10, otaCount: 2 } } }; // 0.8 > 0.5
  const d = decide({ request: {}, snapshot: snap });
  assert.equal(d.route, 'DIRECT');
  assert.equal(d.selectedChannel, 'QTCN');
  assert.ok(d.reasoning.some((r) => /mismatch/.test(r)));
});

test('rule 4: high cancellation risk -> OTA with strictest policy', () => {
  const snap = { availableChannels: ['QTCN', 'booking.com', 'airbnb'] }; // strictness .70 vs .50
  const d = decide({ request: { guestCancellationRate: 1, refundable: true }, snapshot: snap });
  assert.equal(d.route, 'OTA');
  assert.equal(d.selectedChannel, 'booking.com');
});

test('no OTA available -> DIRECT/QTCN', () => {
  const d = decide({ request: {}, snapshot: { availableChannels: ['QTCN'] } });
  assert.equal(d.route, 'DIRECT');
  assert.equal(d.selectedChannel, 'QTCN');
});

test('engine is pure: same input -> same routing fields (id aside)', () => {
  const inp = { request: { guestCancellationRate: 0 }, snapshot: ALL };
  const a = decide(inp, { idGen: () => 'id' });
  const b = decide(inp, { idGen: () => 'id' });
  assert.deepEqual({ ...a }, { ...b });
});

test('decision model validates route + clamps confidence', () => {
  assert.throws(() => makeDecision({ route: 'X', selectedChannel: 'QTCN' }), /route must be/);
  const d = makeDecision({ route: 'OTA', selectedChannel: 'agoda', confidenceScore: 1.5 }, { idGen: () => 'fixed' });
  assert.equal(d.decisionId, 'fixed');
  assert.equal(d.confidenceScore, 1);
});

test('CM bridge maps a decision to a CM target (read-only)', () => {
  const fakeCM = { listChannels: () => ['QTCN', 'BOOKING_COM', 'AGODA'], status: () => ({}) };
  const br = buildChannelManagerBridge({ channelManager: fakeCM });
  assert.deepEqual(br.availableChannels(), ['QTCN', 'BOOKING_COM', 'AGODA']);
  assert.equal(br.plan({ route: 'OTA', selectedChannel: 'booking.com' }).cmChannel, 'BOOKING_COM');
  assert.equal(br.plan({ route: 'DIRECT', selectedChannel: 'QTCN' }).executable, true);
  // A routed OTA with no CM adapter yet is flagged non-executable (needs 1 new file).
  assert.equal(br.plan({ route: 'OTA', selectedChannel: 'makemytrip' }).executable, false);
});

test('PMS bridge produces a read-only snapshot', async () => {
  const br = buildPmsBridge({ availabilityService: { countAvailable: async () => 5 } });
  const snap = await br.inventorySnapshot({ propertyId: 'p', roomTypeId: 'rt', date: '2026-07-01', channels: ['QTCN', 'agoda'] });
  assert.equal(snap.pmsCount, 5);
  assert.deepEqual(snap.availableChannels, ['QTCN', 'agoda']);
});
