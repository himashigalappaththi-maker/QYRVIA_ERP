'use strict';

/**
 * Phase 53 H5 — External ref uniqueness: property_id scoping in memory booking store refKey.
 * Tests that same external_ref + channel + tenant but different property_id creates separate bookings.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

// ── 1. Same external_ref + channel + tenant + DIFFERENT property_id → separate bookings ─────

test('memory store: same external_ref+channel+tenant but different property_id → two separate bookings', () => {
  const store = buildBookingStoreMemory();

  const base = { tenant_id: 't1', channel: 'BOOKING_COM', external_ref: 'BC-001', status: 'CONFIRMED' };

  const r1 = store.upsert({ ...base, property_id: 'p1', guest_name: 'Guest P1' });
  const r2 = store.upsert({ ...base, property_id: 'p2', guest_name: 'Guest P2' });

  assert.equal(r1.accepted, true);
  assert.equal(r1.created, true);
  assert.equal(r2.accepted, true);
  assert.equal(r2.created, true, 'different property_id should create a new booking, not update');

  assert.notEqual(r1.item.id, r2.item.id, 'different property_id must produce different booking ids');
  assert.equal(store.list({ tenant_id: 't1' }).length, 2, 'two distinct bookings in store');
});

// ── 2. Same external_ref + channel + tenant + SAME property_id → idempotent ──

test('memory store: same external_ref+channel+tenant+same property_id → second upsert is idempotent', () => {
  const store = buildBookingStoreMemory();

  const base = { tenant_id: 't1', channel: 'BOOKING_COM', external_ref: 'BC-002', status: 'CONFIRMED', property_id: 'p1' };

  const r1 = store.upsert({ ...base, guest_name: 'Guest First' });
  const r2 = store.upsert({ ...base, guest_name: 'Guest Second', status: 'CHECKED_IN' });

  assert.equal(r1.accepted, true);
  assert.equal(r1.created, true);
  assert.equal(r2.accepted, true);
  assert.equal(r2.created, false, 'same property_id must not create a new booking');

  assert.equal(r1.item.id, r2.item.id, 'same booking id for idempotent upsert');
  assert.equal(r2.item.version, 2, 'version bumped on update');
  assert.equal(store.list({ tenant_id: 't1' }).length, 1, 'only one booking in store');
});

// ── 3. Same external_ref + channel + different tenant → two separate bookings ─

test('memory store: same external_ref+channel but different tenant → two separate bookings', () => {
  const store = buildBookingStoreMemory();

  const base = { channel: 'BOOKING_COM', external_ref: 'BC-003', status: 'CONFIRMED', property_id: null };

  const r1 = store.upsert({ ...base, tenant_id: 't1' });
  const r2 = store.upsert({ ...base, tenant_id: 't2' });

  assert.equal(r1.created, true);
  assert.equal(r2.created, true);
  assert.notEqual(r1.item.id, r2.item.id);
  assert.equal(store.list({ tenant_id: 't1' }).length, 1);
  assert.equal(store.list({ tenant_id: 't2' }).length, 1);
});

// ── 4. property_id null then property_id 'uuid' do not collide ────────────────

test('memory store: upsert with property_id null then property_id uuid does not collide', () => {
  const store = buildBookingStoreMemory();

  const base = { tenant_id: 't1', channel: 'BOOKING_COM', external_ref: 'BC-004', status: 'CONFIRMED' };

  const r1 = store.upsert({ ...base, property_id: null });
  const r2 = store.upsert({ ...base, property_id: 'prop-uuid-1234' });

  assert.equal(r1.created, true);
  assert.equal(r2.created, true, 'null and non-null property_id must not collide');
  assert.notEqual(r1.item.id, r2.item.id, 'different property scopes produce different rows');
  assert.equal(store.list({ tenant_id: 't1' }).length, 2, 'two distinct bookings in store');
});

// ── 5. getByExternalRef with property_id finds the correct scoped booking ─────

test('memory store: getByExternalRef with property_id finds the correct property-scoped booking', () => {
  const store = buildBookingStoreMemory();

  const base = { tenant_id: 't1', channel: 'BOOKING_COM', external_ref: 'BC-005', status: 'CONFIRMED' };

  store.upsert({ ...base, property_id: 'p1', guest_name: 'Guest P1' });
  store.upsert({ ...base, property_id: 'p2', guest_name: 'Guest P2' });

  const rowP1 = store.getByExternalRef('t1', 'BOOKING_COM', 'BC-005', 'p1');
  const rowP2 = store.getByExternalRef('t1', 'BOOKING_COM', 'BC-005', 'p2');

  assert.ok(rowP1, 'p1 booking should be found');
  assert.ok(rowP2, 'p2 booking should be found');
  assert.equal(rowP1.guest_name, 'Guest P1');
  assert.equal(rowP2.guest_name, 'Guest P2');
  assert.notEqual(rowP1.id, rowP2.id);
});
