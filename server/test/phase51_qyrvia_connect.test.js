'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

/**
 * Phase 51 — QYRVIA Connect platform correction tests.
 *
 * QYRVIA Connect is a QYRVIA-owned B2B OTA/distribution platform.
 * Canonical channel code: QYRVIA_CONNECT. QTCN is a legacy alias only.
 *
 * These tests enforce that contract:
 *   - defaultChannels uses code QYRVIA_CONNECT and qyrvia_owned=true
 *   - QYRVIA_CONNECT seeded as live+enabled; external OTAs are not
 *   - realProcessor dispatches QYRVIA_CONNECT (and legacy QTCN) via in-process transport
 *   - realProcessor output always uses canonical QYRVIA_CONNECT code
 *   - ChannelManagerCore.status() uses qyrvia_owned in API response
 *   - QYRVIA_CONNECT is absent from the OTA HTTP provider registry
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── 1. defaultChannels contract ───────────────────────────────────────────────

const { DEFAULT_CHANNELS } = require('../src/channel-manager/registry/defaultChannels');

test('QYRVIA_CONNECT has qyrvia_owned=true, display name "QYRVIA Connect", zero commission', () => {
  const ch = DEFAULT_CHANNELS.find((c) => c.code === 'QYRVIA_CONNECT');
  assert.ok(ch, 'QYRVIA_CONNECT must be in default channels');
  assert.equal(ch.name, 'QYRVIA Connect');
  assert.equal(ch.qyrvia_owned, true);
  assert.equal(ch.commissionPct, 0);
  assert.equal(ch.internal, undefined, 'internal field must not exist — replaced by qyrvia_owned');
});

test('all external OTAs have qyrvia_owned=false (no auto-promotion to live)', () => {
  const external = DEFAULT_CHANNELS.filter((c) => c.code !== 'QYRVIA_CONNECT');
  assert.equal(external.length, 7, 'must be exactly 7 external OTAs');
  for (const ch of external) {
    assert.equal(ch.qyrvia_owned, false, `${ch.code} must have qyrvia_owned=false`);
  }
});

// ── 2. channelRegistryService seeding ─────────────────────────────────────────

const { buildChannelRegistryService } = require('../src/channel-manager/registry/channelRegistryService');

function makeRepo() {
  const rows = [];
  return {
    async list({ tenantId }) { return rows.filter((r) => r.tenant_id === tenantId); },
    async findByCode(code, { tenantId }) {
      return rows.find((r) => r.tenant_id === tenantId && r.channel_code === code) || null;
    },
    async seed(row) {
      const exists = rows.find((r) => r.tenant_id === row.tenant_id && r.channel_code === row.channel_code);
      if (exists) return exists;
      rows.push({ ...row });
      return row;
    },
    async upsert(row) { rows.push(row); return row; },
    async updateFields(code, fields, { tenantId }) {
      const r = rows.find((x) => x.tenant_id === tenantId && x.channel_code === code);
      if (r) Object.assign(r, fields);
      return r || null;
    },
    async toggle(code, { tenantId }) {
      const r = rows.find((x) => x.tenant_id === tenantId && x.channel_code === code);
      if (r) r.enabled = !r.enabled;
      return r || null;
    },
  };
}

test('channelRegistryService seeds QYRVIA_CONNECT as enabled+live (QYRVIA-owned B2B OTA/distribution platform)', async () => {
  const repo = makeRepo();
  const svc  = buildChannelRegistryService({ repo });
  await svc.list({ tenantId: 'T1' });
  const ch = await svc.get('QYRVIA_CONNECT', { tenantId: 'T1' });
  assert.ok(ch, 'QYRVIA_CONNECT must be seeded');
  assert.equal(ch.enabled, true);
  assert.equal(ch.status, 'live');
});

test('channelRegistryService seeds BOOKING_COM as disabled+not_configured', async () => {
  const repo = makeRepo();
  const svc  = buildChannelRegistryService({ repo });
  await svc.list({ tenantId: 'T1' });
  const bcom = await svc.get('BOOKING_COM', { tenantId: 'T1' });
  assert.ok(bcom);
  assert.equal(bcom.enabled, false);
  assert.equal(bcom.status, 'not_configured');
});

test('channelRegistryService: no external OTA is seeded as live', async () => {
  const repo = makeRepo();
  const svc  = buildChannelRegistryService({ repo });
  const items = await svc.list({ tenantId: 'T1' });
  const external = items.filter((i) => i.channel_code !== 'QYRVIA_CONNECT');
  assert.ok(external.length > 0, 'must have external OTAs');
  for (const ch of external) {
    assert.notEqual(ch.status, 'live', `${ch.channel_code} must not be seeded as live`);
  }
});

// ── 3. realProcessor: QYRVIA_CONNECT in-process dispatch ──────────────────────

const { buildRealProcessor } = require('../src/channel-manager/worker/realProcessor');

function makeSecretProvider(secret = null) {
  return { async get() { return secret; } };
}

const QYRVIA_CONNECT_BASE = {
  action:          'CREATE_BOOKING',
  channel:         'QYRVIA_CONNECT',
  tenant_id:       'T1',
  credentials_ref: null,
  payload:         { bookingId: 'BK-Q1', status: 'CONFIRMED' },
};

test('realProcessor: QYRVIA_CONNECT dispatches via in-process (not no_provider_for_channel)', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process(QYRVIA_CONNECT_BASE);
  assert.equal(out.ok, true);
  assert.equal(out.result.dispatch, 'in_process');
  assert.equal(out.result.channel, 'QYRVIA_CONNECT');
  assert.ok(out.result.ackId, 'ackId must be set from in-process transport');
});

test('realProcessor: QYRVIA_CONNECT CREATE_BOOKING → ok=true, dispatch=in_process', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ ...QYRVIA_CONNECT_BASE, action: 'CREATE_BOOKING' });
  assert.equal(out.ok, true);
  assert.equal(out.result.action, 'CREATE_BOOKING');
  assert.equal(out.result.dispatch, 'in_process');
});

test('realProcessor: QYRVIA_CONNECT CANCEL_BOOKING → ok=true, payload.status=CANCELLED', async () => {
  const deliveries = [];
  const qtcnTransport = {
    async send(req) { deliveries.push(req); return { ok: true, status: 200, ackId: 'ack-cancel' }; }
  };
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider(), qtcnTransport });
  const out = await p.process({ ...QYRVIA_CONNECT_BASE, action: 'CANCEL_BOOKING' });
  assert.equal(out.ok, true);
  assert.equal(out.result.dispatch, 'in_process');
  assert.equal(deliveries[0].payload.status, 'CANCELLED');
});

test('realProcessor: QYRVIA_CONNECT UPDATE_BOOKING → ok=true, dispatch=in_process', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ ...QYRVIA_CONNECT_BASE, action: 'UPDATE_BOOKING' });
  assert.equal(out.ok, true);
  assert.equal(out.result.dispatch, 'in_process');
});

test('realProcessor: legacy QTCN code is accepted and output uses canonical QYRVIA_CONNECT', async () => {
  const p   = buildRealProcessor({ secretProvider: makeSecretProvider() });
  const out = await p.process({ ...QYRVIA_CONNECT_BASE, channel: 'QTCN' });
  assert.equal(out.ok, true);
  assert.equal(out.result.dispatch, 'in_process');
  assert.equal(out.result.channel, 'QYRVIA_CONNECT', 'output must use canonical code even for legacy input');
});

test('realProcessor: QYRVIA_CONNECT has no OTA HTTP codec (uses in-process only)', () => {
  const providers = require('../src/channel-manager/ota/providers');
  assert.equal(providers.hasProvider('QYRVIA_CONNECT'), false, 'QYRVIA_CONNECT must have no HTTP OTA codec');
  assert.throws(() => providers.getProvider('QYRVIA_CONNECT'), /no transport provider/);
});

// ── 4. ChannelManagerCore.status() API shape ──────────────────────────────────

test('ChannelManagerCore.status() uses qyrvia_owned not internal in response', () => {
  const { ChannelManagerCore } = require('../src/channel-manager/core/ChannelManagerCore');
  const { BookingComAdapter }  = require('../src/channel-manager/adapters/bookingcom/BookingComAdapter');
  const silentBus = { emitted: [], emit(e) { this.emitted.push(e); return Promise.resolve(); } };
  const core = new ChannelManagerCore({ eventBus: silentBus });
  core.registerAdapter(new BookingComAdapter());
  const s  = core.status();
  const ch = s.channels[0];
  assert.ok('qyrvia_owned' in ch, 'status() must include qyrvia_owned field');
  assert.ok(!('internal' in ch), 'status() must not include internal field');
});
