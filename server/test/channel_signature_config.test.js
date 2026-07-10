'use strict';

/**
 * Phase 53 Fix 1 — env-controlled webhook signature requirement.
 * Tests that buildChannelInbound honours requireSignature and that
 * the env default (CHANNEL_WEBHOOK_REQUIRE_SIGNATURE absent) results in true.
 * Uses memory stores and fake implementations only; no live DB.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildWebhookIngress } = require('../src/channel-manager/inbound/webhookIngress');
const { buildChannelInboundService } = require('../src/channel-manager/inbound/channelInboundService');
const { buildBookingStoreMemory } = require('../src/channel-manager/persistence/memoryStores');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

function fakeCommandBus() {
  let n = 0;
  return { async dispatch() { return { ok: true, result: { id: 'res-' + (++n) } }; } };
}

function fakeAdapter() {
  return {
    channel: 'BOOKING_COM',
    handleWebhook: (req) => ({
      verified: true,
      events: [{ bookingId: 'B1', channel: 'BOOKING_COM', status: 'CONFIRMED', externalRef: 'B1', roomTypeId: 'rt1', arrival: '2026-10-01', departure: '2026-10-03', guestName: 'G' }]
    })
  };
}

function fakeRegistry(adapter) {
  return { get: (c) => { if (c !== adapter.channel) throw new Error('unknown'); return adapter; } };
}

// ── requireSignature: true → webhook without signature is rejected ─────────────

test('buildChannelInbound: requireSignature=true, no secret, no signature → signature_required (401)', async () => {
  const store = buildBookingStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: fakeCommandBus() });
  const adapter = fakeAdapter();
  const ingress = buildWebhookIngress({
    registry: fakeRegistry(adapter),
    inboundService: svc,
    resolveSecret: async () => null,  // no secret configured
    requireSignature: true
  });

  const out = await ingress.handle({ channel: 'BOOKING_COM', body: { bookings: [] }, ctx: CTX });
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'signature_required');
});

// ── requireSignature: false → webhook without signature is accepted ────────────

test('buildChannelInbound: requireSignature=false, no secret, no signature → accepted', async () => {
  const store = buildBookingStoreMemory();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: fakeCommandBus() });
  const adapter = fakeAdapter();
  const ingress = buildWebhookIngress({
    registry: fakeRegistry(adapter),
    inboundService: svc,
    resolveSecret: async () => null,  // no secret configured
    requireSignature: false
  });

  const body = { bookings: [{ id: 'B1', status: 'CONFIRMED' }] };
  const out = await ingress.handle({ channel: 'BOOKING_COM', body, ctx: CTX });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
});

// ── Env default: CHANNEL_WEBHOOK_REQUIRE_SIGNATURE absent → 'true' (default safe) ──

test('env default: CHANNEL_WEBHOOK_REQUIRE_SIGNATURE absent resolves to true in env config', () => {
  // Reload env module with the variable unset to test the default
  delete require.cache[require.resolve('../src/config/env')];
  const savedVal = process.env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE;
  delete process.env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE;
  try {
    const env = require('../src/config/env');
    // Default must be 'true' — and requireSignature must evaluate as !== 'false' → true
    assert.equal(env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE, 'true', 'default must be true');
    assert.equal(env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE !== 'false', true, 'default must evaluate to requireSignature=true');
  } finally {
    if (savedVal !== undefined) process.env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE = savedVal;
    delete require.cache[require.resolve('../src/config/env')];
  }
});

// ── Env override: CHANNEL_WEBHOOK_REQUIRE_SIGNATURE=false → requireSignature=false ──

test('env override: CHANNEL_WEBHOOK_REQUIRE_SIGNATURE=false → requireSignature evaluates to false', () => {
  delete require.cache[require.resolve('../src/config/env')];
  const savedVal = process.env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE;
  process.env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE = 'false';
  try {
    const env = require('../src/config/env');
    assert.equal(env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE, 'false');
    assert.equal(env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE !== 'false', false, 'override=false must evaluate to requireSignature=false');
  } finally {
    if (savedVal !== undefined) process.env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE = savedVal;
    else delete process.env.CHANNEL_WEBHOOK_REQUIRE_SIGNATURE;
    delete require.cache[require.resolve('../src/config/env')];
  }
});
