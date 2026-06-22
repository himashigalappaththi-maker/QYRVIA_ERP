'use strict';

/** Phase 10.1 - mock scenario: Booking.com vs QTCN routing comparison. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decide } = require('../src/qytn/core/qytnEngine');

test('scenario: direct request vs OTA demand for the same property', () => {
  const snapshot = { availableChannels: ['QTCN', 'booking.com'] };

  // A guest arriving via QYRVIA's own surface -> direct, zero-commission.
  const direct = decide({ request: { directRequest: true }, snapshot });
  // The same room reached via OTA demand, low risk, Booking.com @15% (< 18%).
  const viaOta = decide({ request: { directRequest: false, guestCancellationRate: 0.1, leadTimeDays: 10 }, snapshot });

  assert.equal(direct.route, 'DIRECT');
  assert.equal(direct.selectedChannel, 'QTCN');
  assert.equal(viaOta.route, 'OTA');
  assert.equal(viaOta.selectedChannel, 'booking.com');

  // Each decision keeps the other path as a fallback.
  assert.ok(direct.fallbackChain.includes('booking.com'));
  assert.ok(viaOta.fallbackChain.includes('QTCN'));
});

test('scenario: a high-commission OTA pushes revenue back to QTCN', () => {
  const snapshot = { availableChannels: ['QTCN', 'expedia'] }; // expedia @20% > 18%
  const d = decide({ request: { directRequest: false, guestCancellationRate: 0 }, snapshot });
  assert.equal(d.route, 'DIRECT');
  assert.equal(d.selectedChannel, 'QTCN');
  assert.ok(d.reasoning.some((r) => /commission/.test(r)), 'reasoning explains the commission-based reroute');
});

test('scenario: cheapest OTA wins when commissions are healthy and risk is low', () => {
  const snapshot = { availableChannels: ['QTCN', 'booking.com', 'agoda'] };
  const d = decide({ request: { directRequest: false, guestCancellationRate: 0.05 }, snapshot });
  assert.equal(d.route, 'OTA');
  assert.equal(d.selectedChannel, 'booking.com'); // 15% < agoda 18%
});
