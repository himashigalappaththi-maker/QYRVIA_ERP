'use strict';

/** Phase 24 B1-B3 - Channel persistence foundation (interfaces, repos, flag, migration). */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { CONTRACTS, assertImplements } = require('../src/channel-manager/persistence/contracts');
const mem = require('../src/channel-manager/persistence/memoryStores');
const dbm = require('../src/channel-manager/persistence/dbStores');
const { buildChannelPersistence } = require('../src/channel-manager/persistence');

// Fake pg client: records queries, returns a canned row so repos resolve.
function fakeDb() {
  const calls = [];
  return {
    calls,
    query: async (text, params) => { calls.push({ text, params }); return { rows: [{ id: 'x', _text: text }] }; }
  };
}

// ---- 1. Interface compliance ----------------------------------------------
test('interface compliance: memory impls satisfy their contracts', () => {
  const set = {
    booking:    mem.buildBookingStoreMemory(),
    mapping:    mem.buildChannelMappingStoreMemory(),
    queue:      mem.buildSyncQueueStoreMemory(),
    deadLetter: mem.buildDeadLetterStoreMemory(),
    syncState:  mem.buildSyncStateStoreMemory()
  };
  for (const name of Object.keys(CONTRACTS)) {
    const res = assertImplements(name, set[name]);
    assert.ok(res.ok, `${name} memory missing: ${res.missing.join(',')}`);
  }
});

test('interface compliance: db impls satisfy their contracts', () => {
  const db = fakeDb();
  const set = {
    booking:    dbm.buildBookingStoreDb({ db }),
    mapping:    dbm.buildChannelMappingStoreDb({ db }),
    queue:      dbm.buildSyncQueueStoreDb({ db }),
    deadLetter: dbm.buildDeadLetterStoreDb({ db }),
    syncState:  dbm.buildSyncStateStoreDb({ db })
  };
  for (const name of Object.keys(CONTRACTS)) {
    const res = assertImplements(name, set[name]);
    assert.ok(res.ok, `${name} db missing: ${res.missing.join(',')}`);
  }
});

test('db repo requires a db.query client', () => {
  assert.throws(() => dbm.buildBookingStoreDb({ db: null }), /db\.query required/);
});

// ---- 2. Repository CRUD (memory) ------------------------------------------
test('booking_store CRUD + pms link', () => {
  const s = mem.buildBookingStoreMemory({ clock: () => 1 });
  const ins = s.upsert({ tenant_id: 't', channel: 'booking.com', external_ref: 'E1', status: 'PENDING' });
  assert.equal(ins.accepted, true); assert.equal(ins.created, true);
  const id = ins.item.id;
  assert.equal(s.getByExternalRef('t', 'booking.com', 'E1').status, 'PENDING');
  s.setPmsReservationId(id, 'res-1');
  assert.equal(s.getById(id).pms_reservation_id, 'res-1');
  assert.equal(s.list({ tenant_id: 't' }).length, 1);
});

test('mapping_store: room mapping + reservation link', () => {
  const s = mem.buildChannelMappingStoreMemory();
  s.upsertMapping({ tenant_id: 't', property_id: 'p', channel: 'agoda', room_type_id: 'rt1', ota_room_id: 'OTA-1' });
  assert.equal(s.getMapping('t', 'p', 'agoda', 'rt1').ota_room_id, 'OTA-1');
  s.linkReservation({ tenant_id: 't', reservation_id: 'r1', channel: 'agoda', external_id: 'EXT-1' });
  assert.equal(s.getReservationLink('t', 'r1', 'agoda').external_id, 'EXT-1');
  assert.equal(s.list().mappings.length, 1);
  assert.equal(s.list().links.length, 1);
});

test('sync_state_store upsert/get', () => {
  const s = mem.buildSyncStateStoreMemory({ clock: () => 5 });
  s.upsert({ tenant_id: 't', channel: 'expedia', resource_key: 'rt1|2026-07-01', last_hash: 'h1', last_status: 'OK' });
  const row = s.get('t', 'expedia', 'rt1|2026-07-01');
  assert.equal(row.last_hash, 'h1'); assert.equal(row.last_sync_at, 5);
});

// ---- 3. Idempotency constraints -------------------------------------------
test('idempotency: booking upsert dedupes by (tenant, channel, external_ref)', () => {
  const s = mem.buildBookingStoreMemory();
  const a = s.upsert({ tenant_id: 't', channel: 'c', external_ref: 'E', status: 'PENDING' });
  const b = s.upsert({ tenant_id: 't', channel: 'c', external_ref: 'E', status: 'CONFIRMED' });
  assert.equal(a.item.id, b.item.id);       // same row
  assert.equal(b.created, false);
  assert.equal(b.item.version, 2);          // version advances
  assert.equal(s.list().length, 1);
});

test('idempotency: queue partial-unique PENDING (reservation + action)', () => {
  const q = mem.buildSyncQueueStoreMemory();
  assert.equal(q.enqueue({ reservation_id: 'r', action: 'CREATE_BOOKING' }).accepted, true);
  assert.equal(q.enqueue({ reservation_id: 'r', action: 'CREATE_BOOKING' }).deduped, true);
  assert.equal(q.size(), 1);
});

test('idempotency: dead_letter coalesces by (tenant, reservation, action, generation)', () => {
  const dl = mem.buildDeadLetterStoreMemory();
  const a = dl.insert({ tenant_id: 't', reservation_id: 'r', action: 'CREATE_BOOKING', last_error: 'e1' });
  const b = dl.insert({ tenant_id: 't', reservation_id: 'r', action: 'CREATE_BOOKING', last_error: 'e2' });
  assert.equal(b.coalesced, true);
  assert.equal(b.item.id, a.item.id);
  assert.equal(b.item.attempts, 2);
  assert.equal(dl.list().length, 1);
  dl.requestReprocess(a.item.id);
  assert.equal(dl.get(a.item.id).reprocess_requested, true);
});

// ---- 4. Migration validity (static) ---------------------------------------
test('migration 0045 defines all five stores with RLS + idempotency anchors', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/0045_channel_persistence.sql'), 'utf8');
  for (const tbl of ['channel_booking_store', 'channel_mapping_store', 'channel_sync_queue_store',
    'channel_dead_letter_store', 'channel_sync_state_store']) {
    assert.ok(sql.includes('CREATE TABLE ' + tbl), 'missing table ' + tbl);
    assert.ok(new RegExp(tbl + '[\\s\\S]*?ENABLE ROW LEVEL SECURITY').test(sql), 'no RLS on ' + tbl);
  }
  assert.ok(sql.includes('FORCE  ROW LEVEL SECURITY') || sql.includes('FORCE ROW LEVEL SECURITY'));
  assert.ok(/current_setting\('app\.tenant_id', true\)/.test(sql), 'tenant RLS policy missing');
  assert.ok(/UNIQUE \(tenant_id, channel, external_ref\)/.test(sql), 'booking natural key missing');
  assert.ok(/uq_csqs_pending[\s\S]*WHERE status = 'PENDING'/.test(sql), 'queue partial-unique missing');
  assert.ok(/UNIQUE \(tenant_id, reservation_id, action, dedupe_generation\)/.test(sql), 'DLQ coalesce key missing');
  assert.ok(sql.includes('tenant_id') && sql.includes('property_id') && sql.includes('created_at') && sql.includes('updated_at'));
});

// ---- 5. Flag selection logic ----------------------------------------------
test('flag selection: default is memory', () => {
  const p = buildChannelPersistence({});
  assert.equal(p.mode, 'memory');
  assert.equal(typeof p.queue.enqueue, 'function');
});

test('flag selection: db mode without a client falls back to memory', () => {
  const p = buildChannelPersistence({ mode: 'db', db: null });
  assert.equal(p.mode, 'memory(fallback)');
});

test('flag selection: db mode with a client uses db repos', () => {
  const db = fakeDb();
  const p = buildChannelPersistence({ mode: 'db', db });
  assert.equal(p.mode, 'db');
});

test('flag selection: dual mirrors writes to db and returns memory result', () => {
  const db = fakeDb();
  const p = buildChannelPersistence({ mode: 'dual', db });
  assert.equal(p.mode, 'dual');
  const res = p.queue.enqueue({ reservation_id: 'r1', action: 'CREATE_BOOKING' });
  assert.equal(res.accepted, true);                 // memory result returned
  assert.ok(db.calls.length >= 1, 'db mirror was invoked');
  assert.equal(p.queue.size(), 1);                  // memory authoritative
});
