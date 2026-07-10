'use strict';

/**
 * Phase 53 H3 — Reconciliation severity classification.
 * Tests the severity field added to each recommendation and maxSeverity on the result.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { reconcile } = require('../src/channel-manager/ota/reconciliation');

// ── 1. Missing_local reservation drift → critical ─────────────────────────────

test('reconcile: reservation missing_local → severity critical, maxSeverity critical', () => {
  const result = reconcile({
    channel: 'BOOKING_COM',
    local:  { reservations: [] },
    remote: { reservations: [{ id: 'R1', status: 'CONFIRMED' }] }
  });

  assert.equal(result.hasDrift, true);
  assert.ok(result.recommendations.length > 0);
  for (const rec of result.recommendations) {
    assert.equal(rec.severity, 'critical', `expected critical, got ${rec.severity} for ${JSON.stringify(rec)}`);
  }
  assert.equal(result.maxSeverity, 'critical');
});

// ── 2. Reservation value_mismatch → error ─────────────────────────────────────

test('reconcile: reservation value_mismatch → severity error, maxSeverity error', () => {
  const result = reconcile({
    channel: 'BOOKING_COM',
    local:  { reservations: [{ id: 'R1', status: 'CONFIRMED' }] },
    remote: { reservations: [{ id: 'R1', status: 'CANCELLED' }] }
  });

  assert.equal(result.hasDrift, true);
  for (const rec of result.recommendations) {
    assert.equal(rec.severity, 'error');
  }
  assert.equal(result.maxSeverity, 'error');
});

// ── 3. Inventory missing_remote → warn ────────────────────────────────────────

test('reconcile: inventory missing_remote → severity warn', () => {
  const result = reconcile({
    channel: 'BOOKING_COM',
    local:  { inventory: [{ key: 'rt1|2026-08-01', available: 5, stopSell: false }] },
    remote: { inventory: [] }
  });

  assert.equal(result.hasDrift, true);
  const invRec = result.recommendations.find((r) => r.kind === 'inventory' && r.drift_type === 'missing_remote');
  assert.ok(invRec, 'should have inventory missing_remote recommendation');
  assert.equal(invRec.severity, 'warn');
});

// ── 4. Rate value_mismatch → info ────────────────────────────────────────────

test('reconcile: rate value_mismatch → severity info', () => {
  const result = reconcile({
    channel: 'BOOKING_COM',
    local:  { rates: [{ key: 'rt1|2026-08-01', rate: 100, currency: 'USD' }] },
    remote: { rates: [{ key: 'rt1|2026-08-01', rate: 120, currency: 'USD' }] }
  });

  assert.equal(result.hasDrift, true);
  const rateRec = result.recommendations.find((r) => r.kind === 'rate' && r.drift_type === 'value_mismatch');
  assert.ok(rateRec, 'should have rate value_mismatch recommendation');
  assert.equal(rateRec.severity, 'info');
  assert.equal(result.maxSeverity, 'info');
});

// ── 5. Mixed drift (critical + warn) → maxSeverity critical ──────────────────

test('reconcile: mixed drift (missing_local reservation + inventory missing_remote) → maxSeverity critical', () => {
  const result = reconcile({
    channel: 'BOOKING_COM',
    local: {
      inventory: [{ key: 'rt1|2026-08-01', available: 5, stopSell: false }],
      reservations: []
    },
    remote: {
      inventory: [],
      reservations: [{ id: 'R1', status: 'CONFIRMED' }]
    }
  });

  assert.equal(result.hasDrift, true);
  // Must have both critical and warn recommendations
  const severities = result.recommendations.map((r) => r.severity);
  assert.ok(severities.includes('critical'), 'should have at least one critical recommendation');
  assert.ok(severities.includes('warn'), 'should have at least one warn recommendation');

  // maxSeverity must be critical (highest)
  assert.equal(result.maxSeverity, 'critical');
});

// ── 6. No drift → maxSeverity null, empty recommendations ─────────────────────

test('reconcile: no drift → maxSeverity null, empty recommendations', () => {
  const result = reconcile({
    channel: 'BOOKING_COM',
    local: {
      inventory: [{ key: 'rt1|2026-08-01', available: 5, stopSell: false }],
      rates: [{ key: 'rt1|2026-08-01', rate: 100, currency: 'USD' }],
      reservations: [{ id: 'R1', status: 'CONFIRMED' }]
    },
    remote: {
      inventory: [{ key: 'rt1|2026-08-01', available: 5, stopSell: false }],
      rates: [{ key: 'rt1|2026-08-01', rate: 100, currency: 'USD' }],
      reservations: [{ id: 'R1', status: 'CONFIRMED' }]
    }
  });

  assert.equal(result.hasDrift, false);
  assert.equal(result.recommendations.length, 0);
  assert.equal(result.maxSeverity, null);
});

// ── 7. Severity field exists on all recommendation objects ────────────────────

test('reconcile: every recommendation object has a severity field', () => {
  const result = reconcile({
    channel: 'BOOKING_COM',
    local: {
      inventory: [{ key: 'rt1|2026-08-01', available: 3, stopSell: false }],
      rates: [{ key: 'rt1|2026-08-01', rate: 100, currency: 'USD' }],
      reservations: []
    },
    remote: {
      inventory: [{ key: 'rt1|2026-08-01', available: 5, stopSell: false }],
      rates: [{ key: 'rt1|2026-08-01', rate: 150, currency: 'USD' }],
      reservations: [{ id: 'R9', status: 'CONFIRMED' }]
    }
  });

  assert.ok(result.recommendations.length > 0, 'should have recommendations');
  for (const rec of result.recommendations) {
    assert.ok('severity' in rec, `recommendation missing severity field: ${JSON.stringify(rec)}`);
    assert.ok(['critical', 'error', 'warn', 'info'].includes(rec.severity),
      `invalid severity value: ${rec.severity}`);
  }
  // Existing fields must remain unchanged
  for (const rec of result.recommendations) {
    assert.ok('drift_type' in rec);
    assert.ok('action' in rec);
    assert.ok('resource_key' in rec);
  }
});
