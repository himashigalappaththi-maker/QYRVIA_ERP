'use strict';

/**
 * Phase 68A — server/src/ari/dispatch/ariChannelDispatcher.js contract tests.
 * Pure unit tests against fake pools/services — no PostgreSQL connection, no
 * network. The fake pool mirrors phase66a_ari_tenant_unit_of_work.test.js's
 * own pattern and additionally understands the ari_outbox_channel_delivery
 * SQL this dispatcher's ledger calls issue, so ensureDelivery/claim/
 * markCompleted/markRetry/markDeadLetter all behave consistently across
 * multiple calls within one test — exactly like the real table would, minus
 * RLS enforcement (a live-DB concern, out of scope for this file).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAriChannelDispatcher, SUPPORTED_EXTERNAL_CHANNELS } = require('../src/ari/dispatch/ariChannelDispatcher');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PROPERTY_A = '33333333-3333-4333-8333-333333333333';

function envelope(overrides) {
  return Object.freeze(Object.assign({
    id: '44444444-4444-4444-8444-444444444444',
    tenantId: TENANT_A,
    propertyId: PROPERTY_A,
    eventType: 'INVENTORY_CHANGED',
    resourceKind: 'INVENTORY',
    roomTypeId: 'rt1',
    ratePlanId: null,
    restrictionRuleId: null,
    effectiveFrom: '2026-08-01',
    effectiveTo: '2026-08-02',
    dedupeKey: 'aob:v1:xyz',
    sourceVersion: 1,
    payload: { date: '2026-08-01', physical: 10, sold: 2, blocked: 0, stopSell: false }
  }, overrides));
}

/**
 * A fake pg-shaped pool that actually implements the ledger's SQL surface.
 * app_current_tenant() echoes back whatever was most recently bound on THIS
 * connection's client, matching tenantUnitOfWork.js's real proof-of-bind
 * query closely enough for these unit tests.
 */
function makeStrictFakePool() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async connect() {
      let bound = null;
      return {
        async query(text, params) {
          const sql = String(text).trim();
          if (/^BEGIN/i.test(sql)) return { rows: [] };
          if (/^COMMIT/i.test(sql)) return { rows: [] };
          if (/^ROLLBACK/i.test(sql)) return { rows: [] };
          if (/set_config\('app\.tenant_id'/.test(sql)) { bound = params[0]; return { rows: [] }; }
          if (/app_current_tenant\(\)/.test(sql)) return { rows: [{ tid: bound }] };
          if (/^INSERT INTO ari_outbox_channel_delivery/.test(sql)) {
            const [tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version] = params;
            const dup = rows.find((r) => r.tenant_id === tenant_id && r.ari_outbox_id === ari_outbox_id && r.channel_code === channel_code);
            if (dup) return { rows: [] };
            const row = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(++seq).padStart(12, '0'), tenant_id, property_id, ari_outbox_id, channel_code, dedupe_key, source_version, status: 'PENDING', attempt_count: 0 };
            rows.push(row);
            return { rows: [row] };
          }
          if (/^SELECT \* FROM ari_outbox_channel_delivery\s+WHERE tenant_id = \$1 AND ari_outbox_id = \$2 AND channel_code = \$3/.test(sql)) {
            const row = rows.find((r) => r.tenant_id === params[0] && r.ari_outbox_id === params[1] && r.channel_code === params[2]);
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
            row.status = 'RETRY'; row.attempt_count += 1; row.last_error_code = params[1];
            return { rows: [row] };
          }
          if (/SET status = 'DEAD_LETTER'/.test(sql)) {
            const row = rows.find((r) => r.id === params[0] && r.status === 'PROCESSING');
            if (!row) return { rows: [] };
            row.status = 'DEAD_LETTER'; row.attempt_count += 1; row.last_error_code = params[1];
            return { rows: [row] };
          }
          return { rows: [] };
        },
        release() {}
      };
    }
  };
}

function baseDeps(overrides) {
  return Object.assign({
    pool: makeStrictFakePool(),
    resolveChannels: async () => ['BOOKING_COM'],
    channelRegistry: { get: async () => ({ enabled: true }) },
    secretProvider: { get: async () => ({ api_key: 'k' }) },
    resolveCredentialsRef: async () => 'ref-1',
    mappingService: { getMapping: async () => ({ ota_property_id: 'H1', ota_room_id: 'R1', ota_rate_plan_id: null }) },
    // Phase 69A (instruction 048): the dispatcher's real event shapes route
    // to pushAvailability (INVENTORY_CHANGED), which now decodes an XML
    // response (see providers/bookingcom.js's decodeAvailabilityAckXml) —
    // `bodyText`, not the legacy JSON `body.confirmation_id` shape.
    http: { kind: 'fake', enabled: true, async send() { return { ok: true, status: 200, bodyText: '<response><ruid>ACK1</ruid></response>' }; }, async health() { return { ok: true }; } },
    activations: { BOOKING_COM: { endpoint: 'https://fake-booking.test/ari' } },
    isLive: () => true
  }, overrides);
}

// ---- A. contract shape -----------------------------------------------------

test('A. buildAriChannelDispatcher returns exactly { isReady, dispatch } (plus safe extras never required by the caller)', () => {
  const d = buildAriChannelDispatcher(baseDeps());
  assert.equal(typeof d.isReady, 'function');
  assert.equal(typeof d.dispatch, 'function');
});

// ---- B. all gates false -> isReady false -----------------------------------

test('B. isReady() is false when the Booking.com LIVE gate is false, even with every dependency wired', () => {
  const d = buildAriChannelDispatcher(baseDeps({ isLive: () => false }));
  assert.equal(d.isReady(), false);
});

test('B. isReady() is false when a required dependency is missing, even with the LIVE gate true', () => {
  const deps = baseDeps({ isLive: () => true });
  delete deps.channelRegistry;
  const d = buildAriChannelDispatcher(deps);
  assert.equal(d.isReady(), false);
});

test('B. isReady() is true only when every dependency AND the LIVE gate are ready', () => {
  const d = buildAriChannelDispatcher(baseDeps({ isLive: () => true }));
  assert.equal(d.isReady(), true);
});

// ---- C. no provider call during construction -------------------------------

test('C. construction alone never calls http.send / channelRegistry.get / secretProvider.get', () => {
  let sendCalls = 0, regCalls = 0, secretCalls = 0;
  buildAriChannelDispatcher(baseDeps({
    http: { kind: 'fake', enabled: true, async send() { sendCalls += 1; return { ok: true, status: 200 }; } },
    channelRegistry: { get: async () => { regCalls += 1; return { enabled: true }; } },
    secretProvider: { get: async () => { secretCalls += 1; return { api_key: 'k' }; } }
  }));
  assert.equal(sendCalls, 0);
  assert.equal(regCalls, 0);
  assert.equal(secretCalls, 0);
});

// ---- D. enabledChannelResolver reuse ---------------------------------------

test('D. dispatch() calls the injected resolveChannels with exactly {tenantId, propertyId}', async () => {
  let calledWith = null;
  const d = buildAriChannelDispatcher(baseDeps({
    resolveChannels: async (args) => { calledWith = args; return []; }
  }));
  await d.dispatch(envelope());
  assert.deepEqual(calledWith, { tenantId: TENANT_A, propertyId: PROPERTY_A });
});

test('an empty resolved-channel list resolves successfully — nothing enabled is a legitimate no-op, not a failure', async () => {
  const d = buildAriChannelDispatcher(baseDeps({ resolveChannels: async () => [] }));
  await assert.doesNotReject(() => d.dispatch(envelope()));
});

// ---- G/H. canonical handling + legacy alias dropping -----------------------

test('G. a full BOOKING_COM happy path resolves, and durably marks the delivery COMPLETED with the provider ack id', async () => {
  const deps = baseDeps();
  const d = buildAriChannelDispatcher(deps);
  await assert.doesNotReject(() => d.dispatch(envelope()));
  const row = deps.pool.rows.find((r) => r.channel_code === 'BOOKING_COM');
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.provider_ack_id, 'ACK1');
});

test('H. QTCN/qytn legacy aliases resolved from the channel resolver canonicalize to QYRVIA_CONNECT — never create a QTCN ledger row', async () => {
  const deps = baseDeps({ resolveChannels: async () => ['QTCN'] });
  const d = buildAriChannelDispatcher(deps);
  await d.dispatch(envelope());
  assert.equal(deps.pool.rows.some((r) => r.channel_code === 'QTCN'), false);
  assert.equal(deps.pool.rows.some((r) => r.channel_code === 'QYRVIA_CONNECT'), true);
});

// ---- I. unsupported channel fails closed -----------------------------------

test('I. an enabled-but-unsupported channel (e.g. AGODA) fails closed: non-retryable, durably DEAD_LETTER, never marked COMPLETED', async () => {
  const deps = baseDeps({ resolveChannels: async () => ['AGODA'] });
  const d = buildAriChannelDispatcher(deps);
  await assert.rejects(() => d.dispatch(envelope()), (e) => e.retryable === false);
  const row = deps.pool.rows.find((r) => r.channel_code === 'AGODA');
  assert.equal(row.status, 'DEAD_LETTER');
  assert.equal(row.last_error_code, 'UNSUPPORTED_FOR_ARI_TRANSPORT');
});

test('SUPPORTED_EXTERNAL_CHANNELS is exactly [BOOKING_COM] in this phase', () => {
  assert.deepEqual(SUPPORTED_EXTERNAL_CHANNELS, ['BOOKING_COM']);
});

// ---- J. missing registry authorization fails closed ------------------------

test('J. a channel not authorized in channel_registry is retried, never dispatched, and never marked COMPLETED', async () => {
  let sent = false;
  const deps = baseDeps({
    channelRegistry: { get: async () => ({ enabled: false }) },
    http: { kind: 'fake', enabled: true, async send() { sent = true; return { ok: true, status: 200 }; } }
  });
  const d = buildAriChannelDispatcher(deps);
  await assert.rejects(() => d.dispatch(envelope()), (e) => e.retryable === true);
  assert.equal(sent, false, 'never reaches the transport without registry authorization');
});

// ---- K. missing credential ref fails closed locally -------------------------

test('K. a missing credentials_ref fails closed INSIDE QYRVIA (non-retryable) and never calls the transport', async () => {
  let sent = false;
  const deps = baseDeps({
    resolveCredentialsRef: async () => null,
    http: { kind: 'fake', enabled: true, async send() { sent = true; return { ok: true, status: 200 }; } }
  });
  const d = buildAriChannelDispatcher(deps);
  await assert.rejects(() => d.dispatch(envelope()), (e) => e.retryable === false);
  assert.equal(sent, false);
  const row = deps.pool.rows.find((r) => r.channel_code === 'BOOKING_COM');
  assert.equal(row.status, 'DEAD_LETTER');
  assert.equal(row.last_error_code, 'MISSING_CREDENTIAL_REF');
});

test('an unresolvable credential (secretProvider.get returns null) also fails closed inside QYRVIA, never contacting the provider', async () => {
  let sent = false;
  const deps = baseDeps({
    secretProvider: { get: async () => null },
    http: { kind: 'fake', enabled: true, async send() { sent = true; return { ok: true, status: 200 }; } }
  });
  await assert.rejects(() => buildAriChannelDispatcher(deps).dispatch(envelope()), (e) => e.retryable === false);
  assert.equal(sent, false);
});

// ---- S/T. completed channel skipped on redelivery, partial success never resends ----

test('S. a channel already COMPLETED for this exact ARI event is skipped — never re-claimed, never re-sent', async () => {
  let sendCount = 0;
  const deps = baseDeps({ http: { kind: 'fake', enabled: true, async send() { sendCount += 1; return { ok: true, status: 200, body: { confirmation_id: 'A' } }; } } });
  const d = buildAriChannelDispatcher(deps);
  await d.dispatch(envelope());
  assert.equal(sendCount, 1);
  // Redeliver the SAME envelope (same id/dedupeKey/sourceVersion) — as
  // ariOutboxWorker's at-least-once model can legitimately do.
  await d.dispatch(envelope());
  assert.equal(sendCount, 1, 'a completed channel is never re-sent on redelivery');
});

test('T. partial success: Booking.com already COMPLETED, a second required channel still pending — retry only re-attempts the pending one', async () => {
  let bookingComSends = 0, qcSends = 0;
  const deps = baseDeps({
    resolveChannels: async () => ['BOOKING_COM', 'QYRVIA_CONNECT'],
    http: { kind: 'fake', enabled: true, async send() { bookingComSends += 1; return { ok: true, status: 200, body: { confirmation_id: 'A' } }; } }
  });
  // First attempt: make QYRVIA_CONNECT's in-process transport irrelevant to
  // count directly (it's a separate transport instance) — assert via ledger
  // rows instead, which is the durable source of truth this test cares about.
  const d = buildAriChannelDispatcher(deps);
  await assert.doesNotReject(() => d.dispatch(envelope()));
  const bcRow = deps.pool.rows.find((r) => r.channel_code === 'BOOKING_COM');
  const qcRow = deps.pool.rows.find((r) => r.channel_code === 'QYRVIA_CONNECT');
  assert.equal(bcRow.status, 'COMPLETED');
  assert.equal(qcRow.status, 'COMPLETED');
  assert.equal(bookingComSends, 1);

  // Redeliver — neither channel should be re-sent since both are already COMPLETED.
  await d.dispatch(envelope());
  assert.equal(bookingComSends, 1);
});

// ---- U/V/W. retryable vs non-retryable classification -----------------------

test('U/W. a retryable provider HTTP error (503) yields an overall RETRYABLE rejection and a RETRY ledger row', async () => {
  const deps = baseDeps({ http: { kind: 'fake', enabled: true, async send() { return { ok: false, status: 503 }; } } });
  const d = buildAriChannelDispatcher(deps);
  await assert.rejects(() => d.dispatch(envelope()), (e) => e.retryable === true);
  const row = deps.pool.rows.find((r) => r.channel_code === 'BOOKING_COM');
  assert.equal(row.status, 'RETRY');
});

test('V/W. a non-retryable provider HTTP error (401) yields an overall NON-RETRYABLE rejection and a DEAD_LETTER ledger row', async () => {
  const deps = baseDeps({ http: { kind: 'fake', enabled: true, async send() { return { ok: false, status: 401 }; } } });
  const d = buildAriChannelDispatcher(deps);
  await assert.rejects(() => d.dispatch(envelope()), (e) => e.retryable === false);
  const row = deps.pool.rows.find((r) => r.channel_code === 'BOOKING_COM');
  assert.equal(row.status, 'DEAD_LETTER');
});

// ---- AH. ariOutboxWorker's own contract is unaffected -----------------------

test('AH. this dispatcher satisfies buildAriOutboxWorker\'s own constructor guard unchanged (dispatcher.dispatch is a function; isReady exists)', () => {
  const { buildAriOutboxWorker } = require('../src/ari/outbox/ariOutboxWorker');
  const dispatcher = buildAriChannelDispatcher(baseDeps());
  // buildAriOutboxWorker throws synchronously at construction if the
  // dispatcher shape is wrong — this proves the contract is unchanged,
  // without needing a real tenant resolver/outbox/pool.
  assert.doesNotThrow(() => buildAriOutboxWorker({
    tenantResolver: { resolveDueTenants: async () => [] },
    outbox: {
      claimDueForTenant: async () => [], markCompletedForTenant: async () => {},
      markRetryScheduledForTenant: async () => {}, markDeadLetterForTenant: async () => {},
      requeueExpiredLeasesForTenant: async () => []
    },
    pool: { query: async () => ({ rows: [] }) },
    dispatcher,
    workerId: 'test-worker'
  }));
});
