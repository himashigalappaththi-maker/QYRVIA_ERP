'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./_fixtures');
const { buildDedupKey } = require('../src/channel-manager/ota/dedupKey');

// A sentinel "client" object that satisfies the _requireClient guard without a
// real DB connection.  All fixture repo methods accept but ignore it.
const MOCK_CLIENT = Object.freeze({ _isMockTenantClient: true });

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000000';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000000';
const PROP_1   = 'prop1111-0000-0000-0000-000000000000';
const PROP_2   = 'prop2222-0000-0000-0000-000000000000';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRepo() {
  const r = fx.makeFakeRepos();
  return r.otaInboundEventDedupRepo;
}

function baseEvent(overrides = {}) {
  return Object.assign({
    tenantId:    TENANT_A,
    propertyId:  PROP_1,
    channelCode: 'booking.com',
    eventType:   'reservation.new',
    dedupKey:    'ext-evt-001'
  }, overrides);
}

// ── 1. First delivery inserts exactly one row ─────────────────────────────────

test('first delivery inserts one row with delivery_count=1 and status=received', async () => {
  const repo = makeRepo();
  const { row, isDuplicate } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  assert.equal(isDuplicate, false);
  assert.equal(row.delivery_count, 1);
  assert.equal(row.processing_status, 'received');
  assert.equal(repo._store.length, 1);
});

// ── 2. Exact duplicate increments delivery_count only ────────────────────────

test('exact duplicate increments delivery_count and returns isDuplicate=true', async () => {
  const repo = makeRepo();
  await repo.upsert(baseEvent(), MOCK_CLIENT);
  const { row, isDuplicate } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  assert.equal(isDuplicate, true);
  assert.equal(row.delivery_count, 2);
  assert.equal(repo._store.length, 1, 'must not create a second row');
});

test('third delivery increments delivery_count to 3', async () => {
  const repo = makeRepo();
  await repo.upsert(baseEvent(), MOCK_CLIENT);
  await repo.upsert(baseEvent(), MOCK_CLIENT);
  const { row } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  assert.equal(row.delivery_count, 3);
  assert.equal(repo._store.length, 1);
});

// ── 3. Different property / channel / event type → distinct rows ──────────────

test('same key but different property_id → distinct row', async () => {
  const repo = makeRepo();
  const { isDuplicate: d1 } = await repo.upsert(baseEvent({ propertyId: PROP_1 }), MOCK_CLIENT);
  const { isDuplicate: d2 } = await repo.upsert(baseEvent({ propertyId: PROP_2 }), MOCK_CLIENT);
  assert.equal(d1, false);
  assert.equal(d2, false);
  assert.equal(repo._store.length, 2);
});

test('same key but different channel_code → distinct row', async () => {
  const repo = makeRepo();
  await repo.upsert(baseEvent({ channelCode: 'booking.com' }), MOCK_CLIENT);
  const { isDuplicate } = await repo.upsert(baseEvent({ channelCode: 'expedia' }), MOCK_CLIENT);
  assert.equal(isDuplicate, false);
  assert.equal(repo._store.length, 2);
});

test('same key but different event_type → distinct row', async () => {
  const repo = makeRepo();
  await repo.upsert(baseEvent({ eventType: 'reservation.new' }), MOCK_CLIENT);
  const { isDuplicate } = await repo.upsert(baseEvent({ eventType: 'reservation.cancelled' }), MOCK_CLIENT);
  assert.equal(isDuplicate, false);
  assert.equal(repo._store.length, 2);
});

// ── 4. NULL-property duplicates collapse correctly ────────────────────────────

test('two null-property events with same key collapse to one row', async () => {
  const repo = makeRepo();
  const evt = baseEvent({ propertyId: null });
  const { isDuplicate: d1 } = await repo.upsert(evt, MOCK_CLIENT);
  const { isDuplicate: d2, row } = await repo.upsert(evt, MOCK_CLIENT);
  assert.equal(d1, false);
  assert.equal(d2, true);
  assert.equal(row.delivery_count, 2);
  assert.equal(repo._store.length, 1);
});

test('null-property and non-null property with same key remain distinct', async () => {
  const repo = makeRepo();
  const { isDuplicate: d1 } = await repo.upsert(baseEvent({ propertyId: null }),  MOCK_CLIENT);
  const { isDuplicate: d2 } = await repo.upsert(baseEvent({ propertyId: PROP_1 }), MOCK_CLIENT);
  assert.equal(d1, false);
  assert.equal(d2, false);
  assert.equal(repo._store.length, 2);
});

// ── 5. Concurrent duplicate inserts → exactly one row ────────────────────────

test('concurrent upserts with same key produce exactly one row', async () => {
  const repo = makeRepo();
  const evt = baseEvent();
  // Simulate concurrent arrival: run both upserts before awaiting either.
  // In the in-memory fixture this is sequential; in the real DB the atomic
  // ON CONFLICT DO UPDATE ensures only one row is ever created.
  const [r1, r2] = await Promise.all([
    repo.upsert(evt, MOCK_CLIENT),
    repo.upsert(evt, MOCK_CLIENT)
  ]);
  assert.equal(repo._store.length, 1, 'exactly one row must exist after concurrent upserts');
  // One was a new insert, one was a duplicate — combined delivery_count is 2
  const counts = [r1.row.delivery_count, r2.row.delivery_count].sort();
  assert.ok(counts[0] >= 1 && counts[1] >= 1, 'delivery_count must be at least 1 for both');
  assert.equal(repo._store[0].delivery_count, 2, 'stored row must reflect both deliveries');
});

// ── 6. Cross-tenant RLS: reads and writes are isolated ───────────────────────

test('tenant B upsert with same key as tenant A creates a separate row (RLS isolation)', async () => {
  const repo = makeRepo();
  const { isDuplicate: dA } = await repo.upsert(baseEvent({ tenantId: TENANT_A }), MOCK_CLIENT);
  const { isDuplicate: dB } = await repo.upsert(baseEvent({ tenantId: TENANT_B }), MOCK_CLIENT);
  assert.equal(dA, false, 'tenant A first delivery is not a duplicate');
  assert.equal(dB, false, 'tenant B cannot see tenant A row — not a duplicate for B');
  assert.equal(repo._store.length, 2, 'two isolated rows, one per tenant');
});

test('tenant B sees isDuplicate=false even when tenant A already processed the same event', async () => {
  const repo = makeRepo();
  await repo.upsert(baseEvent({ tenantId: TENANT_A }), MOCK_CLIENT);
  await repo.markProcessed(repo._store[0].id, 'booking-A', MOCK_CLIENT);
  const { isDuplicate } = await repo.upsert(baseEvent({ tenantId: TENANT_B }), MOCK_CLIENT);
  assert.equal(isDuplicate, false, 'cross-tenant result must not bleed through');
});

// ── 7. Duplicate preserves prior processing_status, processed_at, result_ref ──

test('duplicate delivery does not overwrite processing_status=processed', async () => {
  const repo = makeRepo();
  const { row: first } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  await repo.markProcessed(first.id, 'reservation-xyz', MOCK_CLIENT);

  const { isDuplicate, row: dup } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  assert.equal(isDuplicate, true);
  // Re-fetch from store to confirm status was preserved
  const stored = repo._store.find(r => r.id === first.id);
  assert.equal(stored.processing_status, 'processed', 'must still be processed');
  assert.ok(stored.processed_at,         'processed_at must be preserved');
  assert.equal(stored.result_ref, 'reservation-xyz', 'result_ref must be preserved');
  assert.equal(dup.delivery_count, 2, 'delivery_count must still increment');
});

test('markProcessed only transitions from received — does not re-process on duplicate', async () => {
  const repo = makeRepo();
  const { row } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  await repo.markProcessed(row.id, 'ref-1', MOCK_CLIENT);
  await repo.markProcessed(row.id, 'ref-2-SHOULD-NOT-WIN', MOCK_CLIENT);
  const stored = repo._store[0];
  assert.equal(stored.result_ref, 'ref-1', 'second markProcessed must be a no-op');
});

test('duplicate delivery preserves processing_status=rejected', async () => {
  const repo = makeRepo();
  const { row } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  await repo.markRejected(row.id, 'bad-channel-format', MOCK_CLIENT);
  await repo.upsert(baseEvent(), MOCK_CLIENT);
  const stored = repo._store[0];
  assert.equal(stored.processing_status, 'rejected');
  assert.equal(stored.result_ref, 'bad-channel-format');
});

// ── 8. Duplicate ingestion creates no downstream side effects ─────────────────

test('duplicate delivery skips booking, inventory, payment, audit, and notification', async () => {
  const repo = makeRepo();
  // Simulate a downstream event processor that guards on isDuplicate
  let bookings = 0, inventoryMutations = 0, payments = 0, auditEvents = 0, notifications = 0;

  async function processInboundEvent(event) {
    const { isDuplicate, row } = await repo.upsert(event, MOCK_CLIENT);
    if (isDuplicate) return { skipped: true, reason: 'duplicate', priorId: row.id };
    bookings++;
    inventoryMutations++;
    payments++;
    auditEvents++;
    notifications++;
    await repo.markProcessed(row.id, 'booking-' + bookings, MOCK_CLIENT);
    return { skipped: false };
  }

  const evt = baseEvent();
  const r1 = await processInboundEvent(evt);
  const r2 = await processInboundEvent(evt); // duplicate
  const r3 = await processInboundEvent(evt); // duplicate again

  assert.equal(r1.skipped, false);
  assert.equal(r2.skipped, true);
  assert.equal(r3.skipped, true);

  assert.equal(bookings,          1, 'only one booking created');
  assert.equal(inventoryMutations,1, 'only one inventory mutation');
  assert.equal(payments,          1, 'only one payment');
  assert.equal(auditEvents,       1, 'only one audit event');
  assert.equal(notifications,     1, 'only one notification');
  assert.equal(repo._store.length, 1, 'only one dedup row');
});

// ── 9. SHA-256 fallback key integrates correctly with the repository ──────────

test('SHA-256 fallback key deduplicates correctly via the repository', async () => {
  const repo  = makeRepo();
  const payload = { booking_id: 'B42', room_type: 'DLX', nights: 3 };
  const key1    = buildDedupKey({ payload });
  const key2    = buildDedupKey({ payload }); // same canonical hash

  assert.equal(key1, key2, 'SHA-256 key must be stable for identical payload');
  assert.ok(key1.startsWith('sha256:'));

  const evt = baseEvent({ dedupKey: key1 });
  const { isDuplicate: d1 } = await repo.upsert(evt, MOCK_CLIENT);
  const { isDuplicate: d2 } = await repo.upsert(Object.assign({}, evt, { dedupKey: key2 }), MOCK_CLIENT);

  assert.equal(d1, false);
  assert.equal(d2, true, 'SHA-256 key dedup must collapse identical payloads');
});

test('volatile-field-stripped SHA-256 key deduplicates regardless of timestamp changes', async () => {
  const repo = makeRepo();
  const base = { booking_id: 'B99', room_type: 'STD' };
  const key1 = buildDedupKey({ payload: Object.assign({}, base, { timestamp: '2024-01-01' }) });
  const key2 = buildDedupKey({ payload: Object.assign({}, base, { timestamp: '2024-06-15' }) });

  assert.equal(key1, key2, 'timestamps must not affect dedup key');

  const evt = baseEvent({ dedupKey: key1 });
  await repo.upsert(evt, MOCK_CLIENT);
  const { isDuplicate } = await repo.upsert(Object.assign({}, evt, { dedupKey: key2 }), MOCK_CLIENT);
  assert.equal(isDuplicate, true, 're-delivery with different timestamp must be detected as duplicate');
});

// ── 10. Empty or invalid dedup input fails before SQL execution ───────────────

test('missing client throws OTA_DEDUP_CLIENT_REQUIRED before any DB call', async () => {
  const repo = makeRepo();
  await assert.rejects(
    () => repo.upsert(baseEvent(), undefined),
    (e) => e.code === 'OTA_DEDUP_CLIENT_REQUIRED'
  );
  assert.equal(repo._store.length, 0, 'no row must be created');
});

test('missing tenantId throws INVALID_INPUT before any DB call', async () => {
  const repo = makeRepo();
  await assert.rejects(
    () => repo.upsert(baseEvent({ tenantId: null }), MOCK_CLIENT),
    (e) => e.code === 'INVALID_INPUT'
  );
  assert.equal(repo._store.length, 0);
});

test('empty channelCode throws INVALID_INPUT', async () => {
  const repo = makeRepo();
  await assert.rejects(
    () => repo.upsert(baseEvent({ channelCode: '' }), MOCK_CLIENT),
    (e) => e.code === 'INVALID_INPUT'
  );
  assert.equal(repo._store.length, 0);
});

test('empty eventType throws INVALID_INPUT', async () => {
  const repo = makeRepo();
  await assert.rejects(
    () => repo.upsert(baseEvent({ eventType: '' }), MOCK_CLIENT),
    (e) => e.code === 'INVALID_INPUT'
  );
  assert.equal(repo._store.length, 0);
});

test('empty dedupKey throws INVALID_INPUT', async () => {
  const repo = makeRepo();
  await assert.rejects(
    () => repo.upsert(baseEvent({ dedupKey: '' }), MOCK_CLIENT),
    (e) => e.code === 'INVALID_INPUT'
  );
  assert.equal(repo._store.length, 0);
});

test('invalid dedup key from buildDedupKey (no args) fails before upsert', async () => {
  const repo = makeRepo();
  // buildDedupKey throws OTA_DEDUP_KEY_REQUIRED synchronously — never reaches repo
  assert.throws(() => buildDedupKey(), (e) => e.code === 'OTA_DEDUP_KEY_REQUIRED');
  assert.equal(repo._store.length, 0);
});

test('markProcessed without client throws OTA_DEDUP_CLIENT_REQUIRED', async () => {
  const repo = makeRepo();
  const { row } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  await assert.rejects(
    () => repo.markProcessed(row.id, 'ref', undefined),
    (e) => e.code === 'OTA_DEDUP_CLIENT_REQUIRED'
  );
  assert.equal(repo._store[0].processing_status, 'received', 'status must not change');
});

test('markRejected without client throws OTA_DEDUP_CLIENT_REQUIRED', async () => {
  const repo = makeRepo();
  const { row } = await repo.upsert(baseEvent(), MOCK_CLIENT);
  await assert.rejects(
    () => repo.markRejected(row.id, 'bad', undefined),
    (e) => e.code === 'OTA_DEDUP_CLIENT_REQUIRED'
  );
  assert.equal(repo._store[0].processing_status, 'received', 'status must not change');
});
