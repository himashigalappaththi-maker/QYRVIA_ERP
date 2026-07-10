'use strict';

/**
 * Phase 53 — Credential non-logging test (item 9 gap-fill).
 * Verifies that secrets, guest names, and full payload fields never appear in logs
 * during transport failures, job processing, or inbound audit events.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelInboundService } = require('../src/channel-manager/inbound/channelInboundService');
const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

// ── Spy logger ────────────────────────────────────────────────────────────────

function makeSpyLogger() {
  const entries = [];
  function capture(level, ...args) {
    // Serialize all arguments to string for inspection
    const text = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
    entries.push({ level, text });
  }
  return {
    entries,
    info:  (...a) => capture('info', ...a),
    warn:  (...a) => capture('warn', ...a),
    error: (...a) => capture('error', ...a),
    debug: (...a) => capture('debug', ...a),
    fatal: (...a) => capture('fatal', ...a),
    contains(str) { return entries.some((e) => e.text.includes(str)); }
  };
}

// ── 1. Transport failure does not log auth-header value ───────────────────────

test('transport failure: spy logger does NOT receive auth header value', async () => {
  const spyLogger = makeSpyLogger();
  const SECRET_API_KEY = 'SUPERSECRET_API_KEY_12345';

  // Simulate a transport with a failing send and a spy logger
  const { buildHttpTransport } = require('../src/channel-manager/transport/transport');
  const transport = buildHttpTransport({
    enabled: true,
    fetchImpl: async () => {
      // Simulate 500 error
      const resp = {
        ok: false,
        status: 500,
        json: async () => ({ error: 'internal_server_error' })
      };
      return resp;
    }
  });

  // Build an auth strategy that returns the secret
  const auth = {
    async getAuthHeaders() {
      return { 'Authorization': `Bearer ${SECRET_API_KEY}` };
    }
  };

  const { TransportOTAAdapter } = require('../src/channel-manager/adapters/framework/TransportOTAAdapter');
  const adapter = new TransportOTAAdapter({
    channel: 'BOOKING_COM',
    transport,
    endpoint: 'https://fake-ota.test/api',
    auth,
    logger: spyLogger
  });

  // Attempt a push that will fail
  try {
    await adapter.pushRateUpdate({ amount: 100, currency: 'USD', date: '2026-08-01' });
  } catch (_) { /* failure expected */ }

  // Verify the secret never appears in any log entry
  assert.equal(spyLogger.contains(SECRET_API_KEY), false,
    'secret API key must not appear in any log entry');
});

// ── 2. Job processing failure does not log secret credential value ─────────────

test('job processor: secret credential value never appears in failure log', async () => {
  const spyLogger = makeSpyLogger();
  const SECRET_VALUE = 'SECRETVALUE_XYZ_987654';

  // Fake secret provider that returns a secret
  const secretProvider = {
    async get(ref, ctx) {
      return { api_key: SECRET_VALUE };
    }
  };

  // Build a mock processor that logs but does not process
  const { buildMockProcessor } = require('../src/channel-manager/worker/mockProcessor');
  const processor = buildMockProcessor();

  // Process a job that will be handled by the mock
  const job = {
    id: 'job-1',
    tenant_id: 't1',
    reservation_id: 'res-1',
    action: 'CREATE_BOOKING',
    channel: 'BOOKING_COM',
    payload: { guestName: 'Test', amount: 100, apiKey: SECRET_VALUE }
  };

  try {
    await processor.process(job, { logger: spyLogger, secretProvider });
  } catch (_) { /* may throw */ }

  // The secret must not appear in any log
  assert.equal(spyLogger.contains(SECRET_VALUE), false,
    'secret credential value must not appear in any log entry after job processing');
});

// ── 3. Inbound audit event does not expose guest_name, amount, or full payload ─

test('inbound audit event: does not contain raw guest_name or amount in audit log', async () => {
  const audits = [];
  const store = buildBookingStoreMemory();

  function fakeCommandBus() {
    return { async dispatch() { return { ok: true, result: { id: 'res-1' } }; } };
  }

  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: fakeCommandBus(),
    onAudit: (e) => audits.push(e)
  });

  const GUEST_NAME   = 'VERY_SENSITIVE_GUEST_NAME';
  const AMOUNT_VALUE = '999888777.00';

  await svc.ingest({
    bookingId: 'B-AUDIT-1',
    channel: 'BOOKING_COM',
    status: 'CONFIRMED',
    externalRef: 'B-AUDIT-1',
    roomTypeId: 'rt1',
    arrival: '2026-08-01',
    departure: '2026-08-03',
    guestName: GUEST_NAME,
    amount: AMOUNT_VALUE,
    currency: 'USD'
  }, { ctx: CTX });

  assert.ok(audits.length > 0, 'at least one audit event must be emitted');

  // Serialize all audit events and check for sensitive data
  const auditStr = JSON.stringify(audits);

  assert.equal(auditStr.includes(GUEST_NAME), false,
    'guest_name must not appear in audit events');
  assert.equal(auditStr.includes(AMOUNT_VALUE), false,
    'amount value must not appear in audit events');

  // Audit events should carry only metadata
  const ingested = audits.find((a) => a.type === 'channel.booking_ingested');
  assert.ok(ingested, 'channel.booking_ingested audit event must be present');
  assert.ok('channel' in ingested, 'audit event must have channel');
  assert.ok('external_ref' in ingested, 'audit event must have external_ref');
  assert.ok('action' in ingested, 'audit event must have action');
  // These sensitive fields must not be present
  assert.ok(!('guest_name' in ingested), 'audit event must not have guest_name');
  assert.ok(!('amount' in ingested), 'audit event must not have amount');
});
