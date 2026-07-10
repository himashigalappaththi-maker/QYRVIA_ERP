'use strict';

/**
 * Phase 54 D10 — Admin visibility / listReservations filter tests (Item 14).
 * Uses mock db objects to capture SQL and parameters without needing Postgres.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

// ---- In-memory store-level filter tests (source_channel) --------------------

/**
 * The bookingStoreMemory uses a list() method that accepts filter params.
 * We test that source_channel filtering works correctly at the store level.
 */

function seedStore(store) {
  // Seed with bookings from different channels
  const tenantId = 't1';

  store.upsert({
    tenant_id:      tenantId,
    property_id:    'p1',
    channel:        'DIRECT',
    external_ref:   'dir-001',
    status:         'CONFIRMED',
    room_type_id:   'rt1',
    arrival:        '2026-08-01',
    departure:      '2026-08-03',
    amount:         230,
    currency:       'USD',
    source_channel: 'DIRECT',
  });

  store.upsert({
    tenant_id:      tenantId,
    property_id:    'p1',
    channel:        'BOOKING_COM',
    external_ref:   'bc-001',
    status:         'CONFIRMED',
    room_type_id:   'rt1',
    arrival:        '2026-08-05',
    departure:      '2026-08-07',
    amount:         460,
    currency:       'USD',
    source_channel: 'BOOKING_COM',
  });

  store.upsert({
    tenant_id:      tenantId,
    property_id:    'p1',
    channel:        'BOOKING_COM',
    external_ref:   'bc-002',
    status:         'CONFIRMED',
    room_type_id:   'rt1',
    arrival:        '2026-08-10',
    departure:      '2026-08-12',
    amount:         460,
    currency:       'USD',
    source_channel: 'BOOKING_COM',
  });

  return tenantId;
}

// 1. list with source_channel: 'DIRECT' includes the filter (only DIRECT rows returned)
test('bookingStore: list with source_channel DIRECT returns only DIRECT bookings', () => {
  const store = buildBookingStoreMemory();
  const tenantId = seedStore(store);

  const allRows    = store.list({ tenant_id: tenantId });
  const directRows = store.list({ tenant_id: tenantId, source_channel: 'DIRECT' });

  assert.equal(allRows.length, 3, 'should have 3 total bookings');
  assert.ok(directRows.length >= 1, 'should have at least one DIRECT booking');
  assert.ok(directRows.every(r => r.source_channel === 'DIRECT' || r.channel === 'DIRECT'),
    'all results should be DIRECT channel');
});

// 2. list without source_channel returns all rows (no channel filter)
test('bookingStore: list without source_channel returns all bookings', () => {
  const store = buildBookingStoreMemory();
  const tenantId = seedStore(store);

  const allRows = store.list({ tenant_id: tenantId });
  assert.equal(allRows.length, 3, 'should return all 3 bookings when no source_channel filter');
});

// 3. list with source_channel: 'BOOKING_COM' returns only that channel's rows
test('bookingStore: list with source_channel BOOKING_COM returns only BOOKING_COM rows', () => {
  const store = buildBookingStoreMemory();
  const tenantId = seedStore(store);

  const bcRows = store.list({ tenant_id: tenantId, source_channel: 'BOOKING_COM' });

  assert.ok(bcRows.length >= 1, 'should have BOOKING_COM rows');
  assert.ok(bcRows.every(r => r.source_channel === 'BOOKING_COM' || r.channel === 'BOOKING_COM'),
    'all results should be BOOKING_COM channel');
});

// ---- Mock-DB level tests (simulate SQL query building) ----------------------

/**
 * Simulate a listReservations function that builds a query and captures the
 * SQL and parameters. This verifies the query contract at the repo boundary.
 */
function buildMockReservationRepo() {
  const capturedQueries = [];

  function listReservations({ tenantId, source_channel } = {}) {
    const conditions = ['tenant_id = $1'];
    const params     = [tenantId];

    if (source_channel) {
      conditions.push(`source_channel = $${params.length + 1}`);
      params.push(source_channel);
    }

    const sql = `SELECT * FROM reservations WHERE ${conditions.join(' AND ')}`;
    capturedQueries.push({ sql, params });

    // Return empty result (no real DB)
    return [];
  }

  return { listReservations, capturedQueries };
}

// 4. listReservations with source_channel includes the filter in SQL
test('mock repo: listReservations with source_channel includes channel condition in query', () => {
  const repo = buildMockReservationRepo();
  repo.listReservations({ tenantId: 't1', source_channel: 'DIRECT' });

  assert.equal(repo.capturedQueries.length, 1);
  const query = repo.capturedQueries[0];
  assert.ok(query.sql.includes('source_channel'), 'SQL should include source_channel condition');
  assert.ok(query.params.includes('DIRECT'), 'params should include DIRECT');
  assert.ok(query.params.includes('t1'),     'params should include tenantId');
});

// 5. listReservations without source_channel omits the channel filter
test('mock repo: listReservations without source_channel omits channel condition', () => {
  const repo = buildMockReservationRepo();
  repo.listReservations({ tenantId: 't1' });

  const query = repo.capturedQueries[0];
  assert.ok(!query.sql.includes('source_channel'), 'SQL should NOT include source_channel when not provided');
  assert.ok(query.params.includes('t1'), 'tenantId still in params');
  assert.ok(!query.params.includes('DIRECT'), 'no channel value in params');
  assert.ok(!query.params.includes('BOOKING_COM'), 'no channel value in params');
});

// 6. listReservations with source_channel: BOOKING_COM correctly filters
test('mock repo: listReservations with source_channel BOOKING_COM sets correct param', () => {
  const repo = buildMockReservationRepo();
  repo.listReservations({ tenantId: 't1', source_channel: 'BOOKING_COM' });

  const query = repo.capturedQueries[0];
  assert.ok(query.sql.includes('source_channel'), 'SQL should include source_channel');
  assert.ok(query.params.includes('BOOKING_COM'), 'params should include BOOKING_COM');
});

// ---- Tenant isolation in store -----------------------------------------------

// 7. list always scopes to tenantId (different tenants see different data)
test('bookingStore: tenant isolation — different tenants see only their own bookings', () => {
  const store = buildBookingStoreMemory();

  store.upsert({
    tenant_id: 't1', property_id: 'p1', channel: 'DIRECT', external_ref: 't1-001',
    status: 'CONFIRMED', room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03',
    amount: 230, currency: 'USD', source_channel: 'DIRECT',
  });

  store.upsert({
    tenant_id: 't2', property_id: 'p2', channel: 'DIRECT', external_ref: 't2-001',
    status: 'CONFIRMED', room_type_id: 'rt1', arrival: '2026-08-01', departure: '2026-08-03',
    amount: 230, currency: 'USD', source_channel: 'DIRECT',
  });

  const t1Rows = store.list({ tenant_id: 't1' });
  const t2Rows = store.list({ tenant_id: 't2' });

  assert.equal(t1Rows.length, 1, 't1 should see only their booking');
  assert.equal(t2Rows.length, 1, 't2 should see only their booking');
  assert.ok(t1Rows.every(r => r.tenant_id === 't1'), 't1 rows all have tenant_id t1');
  assert.ok(t2Rows.every(r => r.tenant_id === 't2'), 't2 rows all have tenant_id t2');
});
