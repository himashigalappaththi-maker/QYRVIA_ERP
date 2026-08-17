'use strict';

/**
 * Phase 69A (instruction 049 Section 18) — the CURRENT commercial ARI
 * BOOKING_COM dispatch path REQUIRES token auth. Explicit regression proof
 * that:
 *   A. a missing bookingComTokenProvider dependency fails CLOSED (non-
 *      retryable) BEFORE any provider HTTP dispatch — never silently
 *      falls back to the provider's legacy Basic/api_key path.
 *   B. a token EXCHANGE failure is classified and durably recorded —
 *      never silently downgraded to Basic auth either.
 * Pure unit tests against fake pools/services — no PostgreSQL connection,
 * no network. Mirrors phase68_ari_channel_dispatcher_contract.test.js's own
 * fake-pool pattern.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAriChannelDispatcher } = require('../src/ari/dispatch/ariChannelDispatcher');
const { bookingcom } = require('../src/channel-manager/ota/providers/bookingcom');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
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
  let sent = false;
  let authToHeadersCalled = false;
  const deps = Object.assign({
    pool: makeStrictFakePool(),
    resolveChannels: async () => ['BOOKING_COM'],
    channelRegistry: { get: async () => ({ enabled: true }) },
    secretProvider: { get: async () => ({ client_id: 'cid', client_secret: 'csecret' }) },
    resolveCredentialsRef: async () => 'ref-1',
    mappingService: { getMapping: async () => ({ ota_property_id: 'H1', ota_room_id: '101', ota_rate_plan_id: null }) },
    http: { kind: 'fake', enabled: true, async send() { sent = true; return { ok: true, status: 200, bodyText: '<ok/>' }; }, async health() { return { ok: true }; } },
    activations: { BOOKING_COM: { endpoint: 'https://fake-booking.test/ari' } },
    isLive: () => true
    // bookingComTokenProvider deliberately OMITTED by default in this file.
  }, overrides);
  deps.__wasSent = () => sent;
  return deps;
}

// ---- A. missing bookingComTokenProvider fails closed BEFORE HTTP dispatch --

test('A. BOOKING_COM dispatch with NO bookingComTokenProvider configured fails closed, non-retryable, BEFORE any HTTP attempt', async () => {
  const deps = baseDeps();
  const d = buildAriChannelDispatcher(deps);
  await assert.rejects(() => d.dispatch(envelope()), (e) => e.retryable === false);
  assert.equal(deps.__wasSent(), false, 'the transport is NEVER reached when the token provider is missing');
  const row = deps.pool.rows.find((r) => r.channel_code === 'BOOKING_COM');
  assert.equal(row.status, 'DEAD_LETTER');
  assert.equal(row.last_error_code, 'BOOKING_COM_TOKEN_PROVIDER_REQUIRED');
});

test('A. the legacy Basic/api_key authToHeaders() path is NEVER invoked by the dispatcher when the token provider is missing', async () => {
  let legacyAuthCalled = false;
  const originalAuthToHeaders = bookingcom.authToHeaders;
  bookingcom.authToHeaders = function spy(...args) { legacyAuthCalled = true; return originalAuthToHeaders.apply(this, args); };
  try {
    const deps = baseDeps();
    const d = buildAriChannelDispatcher(deps);
    await assert.rejects(() => d.dispatch(envelope()));
    assert.equal(legacyAuthCalled, false, 'the dispatcher must never call the legacy synchronous auth path for BOOKING_COM');
  } finally {
    bookingcom.authToHeaders = originalAuthToHeaders;
  }
});

// ---- B. token exchange failure never falls back to Basic -------------------

test('B. a token exchange failure (e.g. invalid credentials) is classified and recorded — never silently downgraded to Basic auth', async () => {
  const deps = baseDeps({
    bookingComTokenProvider: {
      getToken: async () => { const e = new Error('bad creds'); e.code = 'BOOKING_COM_TOKEN_INVALID_CREDENTIALS'; e.retryable = false; throw e; },
      toAuthHeaders: async () => { throw new Error('should never be called — getToken() already failed in the pre-flight check'); }
    }
  });
  const d = buildAriChannelDispatcher(deps);
  await assert.rejects(() => d.dispatch(envelope()), (e) => e.retryable === false);
  assert.equal(deps.__wasSent(), false, 'the OTA transport is never reached once the token pre-flight fails');
  const row = deps.pool.rows.find((r) => r.channel_code === 'BOOKING_COM');
  assert.equal(row.status, 'DEAD_LETTER');
  assert.equal(row.last_error_code, 'BOOKING_COM_TOKEN_INVALID_CREDENTIALS');
});

test('B. a RETRYABLE token exchange failure (e.g. 429/5xx) yields a RETRY ledger row, still never falling back to Basic', async () => {
  const deps = baseDeps({
    bookingComTokenProvider: {
      getToken: async () => { const e = new Error('rate limited'); e.code = 'BOOKING_COM_TOKEN_RATE_LIMITED'; e.retryable = true; throw e; },
      toAuthHeaders: async () => { throw new Error('should never be called'); }
    }
  });
  const d = buildAriChannelDispatcher(deps);
  await assert.rejects(() => d.dispatch(envelope()), (e) => e.retryable === true);
  assert.equal(deps.__wasSent(), false);
  const row = deps.pool.rows.find((r) => r.channel_code === 'BOOKING_COM');
  assert.equal(row.status, 'RETRY');
  assert.equal(row.last_error_code, 'BOOKING_COM_TOKEN_RATE_LIMITED');
});

test('B. no request header ever carries "Basic" when a token provider IS configured, even on a fresh happy path', async () => {
  let sentHeaders = null;
  const deps = baseDeps({
    bookingComTokenProvider: {
      getToken: async () => ({ token: 'FAKE-JWT', expiresAt: Date.now() + 3600000, ruid: null, testClaim: true, cached: false }),
      toAuthHeaders: async () => ({ Authorization: 'Bearer FAKE-JWT' })
    },
    http: { kind: 'fake', enabled: true, async send(req) { sentHeaders = req.headers; return { ok: true, status: 200, bodyText: '<ok/>' }; }, async health() { return { ok: true }; } }
  });
  const d = buildAriChannelDispatcher(deps);
  await assert.doesNotReject(() => d.dispatch(envelope()));
  assert.ok(sentHeaders, 'the transport was reached this time (token provider configured)');
  assert.equal(sentHeaders.Authorization, 'Bearer FAKE-JWT');
  assert.ok(!String(sentHeaders.Authorization).includes('Basic'));
});
