'use strict';

/**
 * Phase 53 Fix 3 — channel_booking_import_log population.
 * Tests that channelInboundService writes the correct outcome to the importLog
 * at every return point, and never blocks ingest if the log throws.
 * Uses memory stores and fake implementations only; no live DB.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelInboundService } = require('../src/channel-manager/inbound/channelInboundService');
const { buildBookingStoreMemory, buildImportLogStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

function fakeCommandBus() {
  let n = 0;
  return {
    async dispatch() { return { ok: true, result: { id: 'res-' + (++n) } }; }
  };
}

function failCommandBus() {
  return { async dispatch() { return { ok: false, error: 'pms_error' }; } };
}

function booking(id, channel = 'BOOKING_COM', status = 'CONFIRMED') {
  return {
    bookingId: id, channel, status,
    externalRef: id, roomTypeId: 'rt1',
    arrival: '2026-09-01', departure: '2026-09-03',
    guestName: 'Test Guest'
  };
}

// ── 1. Successful ingest → outcome: 'accepted' ────────────────────────────────

test('importLog: successful ingest writes outcome=accepted with correct channel and external_booking_id', async () => {
  const store = buildBookingStoreMemory();
  const log   = buildImportLogStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: fakeCommandBus(), importLog: log });

  const r = await svc.ingest(booking('IL-1'), { ctx: CTX });
  assert.equal(r.ok, true);
  assert.equal(log._rows.length, 1);
  assert.equal(log._rows[0].outcome, 'accepted');
  assert.equal(log._rows[0].channel_code, 'BOOKING_COM');
  assert.equal(log._rows[0].external_booking_id, 'IL-1');
  assert.equal(log._rows[0].tenant_id, 't1');
});

// ── 2. Deduped ingest → outcome: 'deduped' ───────────────────────────────────

test('importLog: deduped ingest writes outcome=deduped', async () => {
  const store = buildBookingStoreMemory();
  const log   = buildImportLogStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: fakeCommandBus(), importLog: log });

  await svc.ingest(booking('IL-2'), { ctx: CTX });
  log._rows.length = 0; // reset to isolate the dedup call

  const r = await svc.ingest(booking('IL-2'), { ctx: CTX }); // same booking → dedup
  assert.equal(r.deduped, true);
  assert.equal(log._rows.length, 1);
  assert.equal(log._rows[0].outcome, 'deduped');
});

// ── 3. Conflict (zero availability) → outcome: 'rejected', error_message: 'no_availability' ──

test('importLog: conflict (zero availability) writes outcome=rejected, error_message=no_availability', async () => {
  const store = buildBookingStoreMemory();
  const log   = buildImportLogStoreMemory();
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: fakeCommandBus(),
    importLog: log,
    availabilityProvider: async () => 0
  });

  const r = await svc.ingest(booking('IL-3'), { ctx: CTX });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_availability');
  assert.equal(log._rows.length, 1);
  assert.equal(log._rows[0].outcome, 'rejected');
  assert.equal(log._rows[0].error_message, 'no_availability');
});

// ── 4. Channel disabled → outcome: 'rejected', error_message: 'channel_disabled' ────────────

test('importLog: channel disabled writes outcome=rejected, error_message=channel_disabled', async () => {
  const store = buildBookingStoreMemory();
  const log   = buildImportLogStoreMemory();
  const fakeRegistry = { async get() { return { channel_code: 'BOOKING_COM', enabled: false }; } };
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: fakeCommandBus(),
    importLog: log,
    channelRegistry: fakeRegistry
  });

  const r = await svc.ingest(booking('IL-4'), { ctx: CTX });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'channel_disabled');
  assert.equal(log._rows.length, 1);
  assert.equal(log._rows[0].outcome, 'rejected');
  assert.equal(log._rows[0].error_message, 'channel_disabled');
});

// ── 5. importLog.insert throws → ingest still completes normally ───────────────

test('importLog: if importLog.insert throws, ingest still completes normally', async () => {
  const store = buildBookingStoreMemory();
  const throwingLog = {
    async insert() { throw new Error('log_service_down'); }
  };
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: fakeCommandBus(),
    importLog: throwingLog
  });

  const r = await svc.ingest(booking('IL-5'), { ctx: CTX });
  // Ingest must succeed despite the log throwing
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
});

// ── 6. importLog = null (not injected) → backward compat, ingest proceeds ─────

test('importLog: null importLog (not injected) does not affect ingest', async () => {
  const store = buildBookingStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: fakeCommandBus() });

  const r = await svc.ingest(booking('IL-6'), { ctx: CTX });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
});
