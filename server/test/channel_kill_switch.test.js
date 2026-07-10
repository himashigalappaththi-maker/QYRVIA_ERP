'use strict';

/**
 * Phase 53 H2 — Kill-switch enforcement at inbound and outbound.
 * Uses memory stores and fake implementations only; no live DB.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelInboundService } = require('../src/channel-manager/inbound/channelInboundService');
const { buildBookingStoreMemory, buildSyncStateStoreMemory } = require('../src/channel-manager/persistence/memoryStores');
const { buildChannelSyncService } = require('../src/channel-manager/sync/channelSyncService');

const CTX = { tenantId: 't1', propertyId: 'p1', requestId: 'rq', actorId: 'u1' };

function fakeCommandBus() {
  const dispatched = [];
  let n = 0;
  return {
    dispatched,
    async dispatch(name, input) {
      dispatched.push({ name, input });
      return { ok: true, result: { id: 'res-' + (++n) } };
    }
  };
}

function fakeRegistry(enabled) {
  return {
    async get(channelCode, ctx) {
      return { channel_code: channelCode, enabled, status: enabled ? 'live' : 'paused' };
    }
  };
}

function throwingRegistry() {
  return {
    async get() { throw new Error('registry_unavailable'); }
  };
}

function booking(id, channel = 'BOOKING_COM') {
  return {
    bookingId: id, channel, status: 'CONFIRMED',
    externalRef: id, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-03',
    guestName: 'Test Guest'
  };
}

// Minimal adapter registry + sync state store for outbound sync tests
function fakeAdapterRegistry() {
  const fakeAdapter = {
    pushRateUpdate: async () => ({ ok: true }),
    pushAvailability: async () => ({ ok: true }),
    pushReservation: async () => ({ ok: true })
  };
  return {
    get: () => fakeAdapter
  };
}

// ── Inbound: channel disabled ─────────────────────────────────────────────────

test('inbound ingest: channelRegistry returns disabled → channel_disabled, booking store untouched', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: bus,
    channelRegistry: fakeRegistry(false)
  });

  const r = await svc.ingest(booking('KS-1'), { ctx: CTX });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'channel_disabled');

  // Booking store must NOT be touched
  const row = store.getByExternalRef('t1', 'BOOKING_COM', 'KS-1', 'p1');
  assert.equal(row, null, 'no booking stored when channel is disabled');
  assert.equal(bus.dispatched.length, 0, 'no PMS dispatch when channel disabled');
});

// ── Inbound: channel enabled ──────────────────────────────────────────────────

test('inbound ingest: channelRegistry returns enabled → proceeds normally', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: bus,
    channelRegistry: fakeRegistry(true)
  });

  const r = await svc.ingest(booking('KS-2'), { ctx: CTX });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
  assert.equal(bus.dispatched.length, 1);
});

// ── Inbound: no channelRegistry → backward compat ────────────────────────────

test('inbound ingest: no channelRegistry injected → proceeds without kill-switch check', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({ bookingStore: store, commandBus: bus });

  const r = await svc.ingest(booking('KS-3'), { ctx: CTX });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
});

// ── Inbound: registry throws → fail-open (proceeds) ──────────────────────────

test('inbound ingest: channelRegistry.get() throws → fail-open, ingest proceeds', async () => {
  const store = buildBookingStoreMemory();
  const bus = fakeCommandBus();
  const svc = buildChannelInboundService({
    bookingStore: store,
    commandBus: bus,
    channelRegistry: throwingRegistry()
  });

  const r = await svc.ingest(booking('KS-4'), { ctx: CTX });
  // Fail-open: registry error should NOT block inbound
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
});

// ── Outbound: channel disabled ────────────────────────────────────────────────

test('outbound sync push: channelRegistry returns disabled → channel_disabled, skipped:true', async () => {
  const syncStateStore = buildSyncStateStoreMemory();
  const svc = buildChannelSyncService({
    registry: fakeAdapterRegistry(),
    syncStateStore,
    realChannels: new Set(['BOOKING_COM']),
    channelRegistry: fakeRegistry(false)
  });

  const r = await svc.pushRate({
    tenant_id: 't1', property_id: 'p1', channel: 'BOOKING_COM',
    room_type_id: 'rt1', rate: { amount: 100, currency: 'USD', date: '2026-08-01' }
  });

  assert.equal(r.ok, false);
  assert.equal(r.error, 'channel_disabled');
  assert.equal(r.skipped, true);
});

// ── Outbound: channel enabled ─────────────────────────────────────────────────

test('outbound sync push: channelRegistry returns enabled → proceeds normally', async () => {
  const syncStateStore = buildSyncStateStoreMemory();
  const svc = buildChannelSyncService({
    registry: fakeAdapterRegistry(),
    syncStateStore,
    realChannels: new Set(['BOOKING_COM']),
    channelRegistry: fakeRegistry(true)
  });

  const r = await svc.pushRate({
    tenant_id: 't1', property_id: 'p1', channel: 'BOOKING_COM',
    room_type_id: 'rt1', rate: { amount: 100, currency: 'USD', date: '2026-08-01' }
  });

  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
});

// ── Kill endpoint (Fix 4) ─────────────────────────────────────────────────────

const fx = require('./_fixtures');
const { createApp } = require('../src/app');
const { buildChannelRegistryService } = require('../src/channel-manager/registry/channelRegistryService');

const MANAGER_ID = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
const READER_ID  = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const MANAGER_PERMS = ['channel.sync.read', 'channel.sync.run', 'channel.mapping.read'];
const READER_PERMS  = ['channel.sync.read', 'channel.mapping.read'];

function makeKillRegistryRepo() {
  const rows = [];
  let seq = 0;
  return {
    async list({ tenantId, propertyId }) {
      return rows.filter(r => r.tenant_id === tenantId && (r.property_id || '') === (propertyId || ''));
    },
    async findByCode(channelCode, { tenantId, propertyId }) {
      return rows.find(r => r.tenant_id === tenantId && r.channel_code === channelCode &&
        (r.property_id || '') === (propertyId || '')) || null;
    },
    async seed(row) {
      const existing = rows.find(r => r.tenant_id === row.tenant_id && r.channel_code === row.channel_code &&
        (r.property_id || '') === (row.property_id || ''));
      if (existing) return existing;
      const rec = { id: 'KRG' + String(++seq).padStart(3, '0'), ...row,
        property_id: row.property_id || null, kill_switch_at: null, kill_switch_by: null, kill_switch_reason: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      rows.push(rec);
      return rec;
    },
    async upsert(row) {
      const idx = rows.findIndex(r => r.tenant_id === row.tenant_id && r.channel_code === row.channel_code &&
        (r.property_id || '') === (row.property_id || ''));
      if (idx >= 0) { Object.assign(rows[idx], row, { updated_at: new Date().toISOString() }); return rows[idx]; }
      const rec = { id: 'KRG' + String(++seq).padStart(3, '0'), ...row,
        property_id: row.property_id || null, kill_switch_at: null, kill_switch_by: null, kill_switch_reason: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      rows.push(rec);
      return rec;
    },
    async updateFields(channelCode, fields, { tenantId, propertyId }) {
      const rec = rows.find(r => r.tenant_id === tenantId && r.channel_code === channelCode &&
        (r.property_id || '') === (propertyId || ''));
      if (!rec) return null;
      Object.assign(rec, fields, { updated_at: new Date().toISOString() });
      return rec;
    },
    async toggle(channelCode, ctx) {
      const rec = rows.find(r => r.tenant_id === ctx.tenantId && r.channel_code === channelCode &&
        (r.property_id || '') === (ctx.propertyId || ''));
      if (!rec) return null;
      rec.enabled = !rec.enabled;
      rec.updated_at = new Date().toISOString();
      return rec;
    },
    _rows: rows,
  };
}

function makeKillApp() {
  const repos = fx.makeFakeRepos();
  const repo  = makeKillRegistryRepo();
  const channelRegistry = buildChannelRegistryService({ repo });
  repos.identityRepo._seedUser({ id: MANAGER_ID, username: 'manager4', tenant_id: fx.TENANT_A }, [], MANAGER_PERMS);
  repos.identityRepo._seedUser({ id: READER_ID,  username: 'reader4',  tenant_id: fx.TENANT_A }, [], READER_PERMS);
  const app = createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo:   repos.tokensRepo,
    channelManager: { status: () => ({ channels: {}, queue: {}, bookings: {} }), registerAdapter() {} },
    channelRegistry,
  });
  return { app, repo, channelRegistry };
}

test('PATCH /registry/BOOKING_COM/kill: kills channel with reason → 200, kill_switch_at set', async () => {
  const { app, repo } = makeKillApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    // Seed first
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r = await fx.fetchJson(url + '/api/channel/registry/BOOKING_COM/kill', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Fraud detected - emergency shutdown' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.data.kill_switch_at, 'kill_switch_at must be set');
    assert.equal(r.body.data.kill_switch_reason, 'Fraud detected - emergency shutdown');
    assert.equal(r.body.data.enabled, false);
    assert.equal(r.body.data.status, 'paused');
  } finally { srv.close(); }
});

test('PATCH /registry/BOOKING_COM/kill: missing reason → 400 kill_switch_reason_required', async () => {
  const { app } = makeKillApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r = await fx.fetchJson(url + '/api/channel/registry/BOOKING_COM/kill', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /kill_switch_reason_required/);
  } finally { srv.close(); }
});

test('PATCH /registry/UNKNOWN/kill: 404 channel_not_found', async () => {
  const { app } = makeKillApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r = await fx.fetchJson(url + '/api/channel/registry/DOES_NOT_EXIST/kill', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });
    assert.equal(r.status, 404);
    assert.match(String(r.body.error), /channel_not_found/);
  } finally { srv.close(); }
});

test('kill sets kill_switch_at; PATCH /toggle does NOT set kill_switch_at', async () => {
  const { app, repo } = makeKillApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });

    // Toggle AGODA (starts disabled → enable it)
    await fx.fetchJson(url + '/api/channel/registry/AGODA/toggle', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const agoda = repo._rows.find(r => r.channel_code === 'AGODA');
    assert.ok(!agoda.kill_switch_at, 'toggle must NOT set kill_switch_at');

    // Kill BOOKING_COM
    await fx.fetchJson(url + '/api/channel/registry/BOOKING_COM/kill', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'emergency' }),
    });
    const bcom = repo._rows.find(r => r.channel_code === 'BOOKING_COM');
    assert.ok(bcom.kill_switch_at, 'kill must set kill_switch_at');
  } finally { srv.close(); }
});
