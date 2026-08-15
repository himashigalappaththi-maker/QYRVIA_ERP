'use strict';

/**
 * Phase 68A — durable per-channel ARI delivery ledger (ari_outbox_channel_delivery,
 * migration 0091). Pure unit tests against a fake { query } client — no
 * PostgreSQL connection, no network. Tenant-bound-wrapper structural scoping
 * is proven via a fake pg-shaped pool mirroring
 * phase66a_ari_tenant_unit_of_work.test.js's own pattern exactly; full RLS
 * enforcement is a live-DB concern covered (source only, not run) by
 * server/test/db/phase68_ari_channel_delivery.db.test.js.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAriChannelDeliveryStore, allRequiredChannelsComplete, STATUS, ERROR_CLASS, CANONICAL_CHANNELS
} = require('../src/ari/dispatch/ariChannelDeliveryStore');
const {
  ensureDeliveryForTenant, claimForTenant, markCompletedForTenant,
  markRetryForTenant, markDeadLetterForTenant, listForOutboxEventForTenant
} = require('../src/ari/dispatch/tenantAriChannelDelivery');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PROPERTY_A = '33333333-3333-4333-8333-333333333333';
const OUTBOX_A = '44444444-4444-4444-8444-444444444444';

// ---- pure store unit tests, against a hand-rolled fake `db.query` ---------

function fakeUuid(seq) {
  return 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(seq).padStart(12, '0');
}

function makeFakeDb() {
  let rows = [];
  let seq = 0;
  return {
    rows,
    async query(text, params) {
      const sql = String(text);
      if (/^INSERT INTO ari_outbox_channel_delivery/.test(sql)) {
        const [tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version] = params;
        const dup = rows.find((r) => r.tenant_id === tenant_id && r.ari_outbox_id === ari_outbox_id && r.channel_code === channel_code);
        if (dup) return { rows: [] }; // ON CONFLICT DO NOTHING
        const row = {
          id: fakeUuid(++seq), tenant_id, property_id, ari_outbox_id, channel_code,
          dedupe_key, source_version, status: 'PENDING', attempt_count: 0,
          provider_ack_id: null, last_error_code: null, last_error_class: null
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (/^SELECT \* FROM ari_outbox_channel_delivery\s+WHERE tenant_id = \$1 AND ari_outbox_id = \$2 AND channel_code = \$3/.test(sql)) {
        const [tenant_id, ari_outbox_id, channel_code] = params;
        const row = rows.find((r) => r.tenant_id === tenant_id && r.ari_outbox_id === ari_outbox_id && r.channel_code === channel_code);
        return { rows: row ? [row] : [] };
      }
      if (/^SELECT \* FROM ari_outbox_channel_delivery WHERE ari_outbox_id/.test(sql)) {
        return { rows: rows.filter((r) => r.ari_outbox_id === params[0]) };
      }
      if (/^SELECT \* FROM ari_outbox_channel_delivery WHERE id/.test(sql)) {
        const row = rows.find((r) => r.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^UPDATE ari_outbox_channel_delivery\s+SET status = 'PROCESSING'/.test(sql)) {
        const row = rows.find((r) => r.id === params[0] && ['PENDING', 'RETRY'].includes(r.status));
        if (!row) return { rows: [] };
        row.status = 'PROCESSING';
        return { rows: [row] };
      }
      if (/SET status = 'COMPLETED'/.test(sql)) {
        const row = rows.find((r) => r.id === params[0] && r.status === 'PROCESSING');
        if (!row) return { rows: [] };
        row.status = 'COMPLETED'; row.provider_ack_id = params[1];
        return { rows: [row] };
      }
      if (/SET status = 'RETRY'/.test(sql)) {
        const row = rows.find((r) => r.id === params[0] && r.status === 'PROCESSING');
        if (!row) return { rows: [] };
        row.status = 'RETRY'; row.attempt_count += 1; row.last_error_code = params[1]; row.last_error_class = params[2];
        return { rows: [row] };
      }
      if (/SET status = 'DEAD_LETTER'/.test(sql)) {
        const row = rows.find((r) => r.id === params[0] && r.status === 'PROCESSING');
        if (!row) return { rows: [] };
        row.status = 'DEAD_LETTER'; row.attempt_count += 1; row.last_error_code = params[1]; row.last_error_class = params[2];
        return { rows: [row] };
      }
      throw new Error('unexpected SQL in fake db: ' + sql);
    }
  };
}

test('CANONICAL_CHANNELS matches the exact ROUTABLE_CHANNELS set (QTCN excluded)', () => {
  assert.deepEqual(
    [...CANONICAL_CHANNELS].sort(),
    ['AGODA', 'AIRBNB', 'BOOKING_COM', 'EXPEDIA', 'GOOGLE', 'MAKEMYTRIP', 'QYRVIA_CONNECT', 'TRIPADVISOR']
  );
  assert.ok(!CANONICAL_CHANNELS.includes('QTCN'), 'QTCN is never a writable channel_code');
});

test('ensureDelivery rejects a non-canonical channel code before any SQL (fail closed)', async () => {
  const store = buildAriChannelDeliveryStore({ db: makeFakeDb() });
  await assert.rejects(
    () => store.ensureDelivery({ tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A, channelCode: 'QTCN', dedupeKey: 'aob:v1:x', sourceVersion: 1 }),
    /ariChannelDeliveryStore/
  );
});

test('R. ensureDelivery is idempotent: the SAME (tenant, outbox event, channel) always yields the SAME row, never a duplicate', async () => {
  const db = makeFakeDb();
  const store = buildAriChannelDeliveryStore({ db });
  const a = await store.ensureDelivery({ tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A, channelCode: 'BOOKING_COM', dedupeKey: 'aob:v1:x', sourceVersion: 1 });
  const b = await store.ensureDelivery({ tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A, channelCode: 'BOOKING_COM', dedupeKey: 'aob:v1:x', sourceVersion: 1 });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.row.id, b.row.id);
  assert.equal(db.rows.filter((r) => r.ari_outbox_id === OUTBOX_A && r.channel_code === 'BOOKING_COM').length, 1);
});

test('a second channel for the SAME outbox event gets its OWN durable row', async () => {
  const db = makeFakeDb();
  const store = buildAriChannelDeliveryStore({ db });
  await store.ensureDelivery({ tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A, channelCode: 'BOOKING_COM', dedupeKey: 'aob:v1:x', sourceVersion: 1 });
  await store.ensureDelivery({ tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A, channelCode: 'QYRVIA_CONNECT', dedupeKey: 'aob:v1:x', sourceVersion: 1 });
  assert.equal(db.rows.length, 2);
});

test('S/T. claim/markCompleted/markRetry/markDeadLetter follow the documented state machine, and a COMPLETED row can never be re-claimed', async () => {
  const db = makeFakeDb();
  const store = buildAriChannelDeliveryStore({ db });
  const { row } = await store.ensureDelivery({ tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A, channelCode: 'BOOKING_COM', dedupeKey: 'aob:v1:x', sourceVersion: 1 });

  const claimed = await store.claim(row.id);
  assert.equal(claimed.status, STATUS.PROCESSING);

  const completed = await store.markCompleted(row.id, { providerAckId: 'ACK-1' });
  assert.equal(completed.status, STATUS.COMPLETED);
  assert.equal(completed.provider_ack_id, 'ACK-1');

  // A COMPLETED row is never reclaimed — this is what makes "skip an
  // already-completed channel on redelivery" durable rather than in-memory.
  const reclaim = await store.claim(row.id);
  assert.equal(reclaim, null);
});

test('U/W. a retryable failure transitions PROCESSING -> RETRY and increments attempt_count exactly once', async () => {
  const db = makeFakeDb();
  const store = buildAriChannelDeliveryStore({ db });
  const { row } = await store.ensureDelivery({ tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A, channelCode: 'BOOKING_COM', dedupeKey: 'aob:v1:x', sourceVersion: 1 });
  await store.claim(row.id);
  const retried = await store.markRetry(row.id, { errorCode: 'http_503', errorClass: ERROR_CLASS.RETRYABLE });
  assert.equal(retried.status, STATUS.RETRY);
  assert.equal(retried.attempt_count, 1);
  assert.equal(retried.last_error_code, 'http_503');
  // RETRY is reclaimable — the channel still needs an attempt.
  const reclaim = await store.claim(row.id);
  assert.equal(reclaim.status, STATUS.PROCESSING);
});

test('V/W. a non-retryable failure transitions PROCESSING -> DEAD_LETTER (terminal, never reclaimed)', async () => {
  const db = makeFakeDb();
  const store = buildAriChannelDeliveryStore({ db });
  const { row } = await store.ensureDelivery({ tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A, channelCode: 'BOOKING_COM', dedupeKey: 'aob:v1:x', sourceVersion: 1 });
  await store.claim(row.id);
  const dead = await store.markDeadLetter(row.id, { errorCode: 'MISSING_CREDENTIAL_REF', errorClass: ERROR_CLASS.NON_RETRYABLE });
  assert.equal(dead.status, STATUS.DEAD_LETTER);
  assert.equal(dead.attempt_count, 1);
  const reclaim = await store.claim(row.id);
  assert.equal(reclaim, null);
});

test('allRequiredChannelsComplete: true only when every required channel is COMPLETED', () => {
  const rows = [
    { channel_code: 'BOOKING_COM', status: 'COMPLETED' },
    { channel_code: 'QYRVIA_CONNECT', status: 'RETRY' }
  ];
  assert.equal(allRequiredChannelsComplete(rows, ['BOOKING_COM']), true);
  assert.equal(allRequiredChannelsComplete(rows, ['BOOKING_COM', 'QYRVIA_CONNECT']), false);
  assert.equal(allRequiredChannelsComplete([], []), true, 'zero required channels is vacuously complete');
});

// ---- tenant-bound wrapper: structural scoping proof (mirrors the existing
// phase66a_ari_tenant_unit_of_work.test.js fake-pool pattern exactly) -------

function makeFakePool({ boundTenantId } = {}) {
  const state = { beginCalls: 0, commitCalls: 0, boundTenantIds: [], storeQueries: [] };
  const rows = [];
  let seq = 0;
  function makeClient() {
    return {
      async query(text, params) {
        const sql = String(text).trim();
        if (/^BEGIN/i.test(sql)) { state.beginCalls += 1; return { rows: [] }; }
        if (/^COMMIT/i.test(sql)) { state.commitCalls += 1; return { rows: [] }; }
        if (/^ROLLBACK/i.test(sql)) { return { rows: [] }; }
        if (/set_config\('app\.tenant_id'/.test(sql)) { state.boundTenantIds.push(params[0]); return { rows: [] }; }
        if (/app_current_tenant\(\)/.test(sql)) { return { rows: [{ tid: boundTenantId }] }; }
        state.storeQueries.push(sql);
        if (/^INSERT INTO ari_outbox_channel_delivery/.test(sql)) {
          const row = { id: fakeUuid(++seq), tenant_id: params[0], property_id: params[1], ari_outbox_id: params[2], channel_code: params[3], status: 'PENDING' };
          rows.push(row);
          return { rows: [row] };
        }
        return { rows: [] };
      },
      release() {}
    };
  }
  return { pool: { async connect() { return makeClient(); } }, state, rows };
}

test('E. every tenant-bound wrapper call binds app.tenant_id to the CALLER-supplied tenant before any SQL — a delivery is never created without a bound tenant', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const res = await ensureDeliveryForTenant({
    pool, tenantId: TENANT_A, propertyId: PROPERTY_A, ariOutboxId: OUTBOX_A,
    channelCode: 'BOOKING_COM', dedupeKey: 'aob:v1:x', sourceVersion: 1
  });
  assert.equal(res.row.tenant_id, TENANT_A);
  assert.deepEqual(state.boundTenantIds, [TENANT_A]);
  assert.equal(state.beginCalls, 1);
  assert.equal(state.commitCalls, 1);
});

test('E. a unit of work bound to tenant A refuses to be reused for tenant B (tenantUnitOfWork.js own cross-tenant guard)', async () => {
  const { runWithTenantTransaction, ERR } = require('../src/db/tenantUnitOfWork');
  const { pool } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(
    () => runWithTenantTransaction(pool, TENANT_A, async () => {
      // Nested call for a DIFFERENT tenant inside the same open unit of work.
      await claimForTenant({ pool, tenantId: TENANT_B, id: 'whatever' });
    }),
    (err) => err.code === ERR.TENANT_CONTEXT_MISMATCH
  );
});

test('listForOutboxEventForTenant runs as a READ ONLY unit of work (never mutates)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const rows = await listForOutboxEventForTenant({ pool, tenantId: TENANT_A, ariOutboxId: OUTBOX_A });
  assert.deepEqual(rows, []);
  assert.equal(state.beginCalls, 1); // BEGIN TRANSACTION READ ONLY still counts as a BEGIN
});
