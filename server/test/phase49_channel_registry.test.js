'use strict';

/**
 * Phase 49 — Channel Registry contract tests.
 *
 * Tests use an in-memory registry (no DB) wired via DI. The channelRegistry
 * dep is built with an in-memory repo so tests are isolated and fast.
 *
 * Contracts under test:
 *   GET  /api/channel/registry                       → {ok,data:{items:[]}}
 *   POST /api/channel/registry                       → 201 {ok,data:{channel_code,...}}
 *   GET  /api/channel/registry/:channel              → {ok,data:{...}} or 404
 *   PATCH /api/channel/registry/:channel/status      → {ok,data:{status}}
 *   PATCH /api/channel/registry/:channel/toggle      → {ok,data:{enabled}}
 *   POST /api/channel/registry/:channel/sync-error   → {ok,data:{status:'error'}}
 *   POST /api/channel/registry/:channel/sync-ok      → {ok,data:{last_sync_at}}
 *
 * Business rules enforced:
 *   - First list() seeds 8 default channels for the tenant.
 *   - QYRVIA_CONNECT seeds as enabled=true, status='live'.
 *   - All others seed as enabled=false, status='not_configured'.
 *   - status='live' is only set via setStatus(); never auto-promoted.
 *   - toggle() on a live channel → status becomes 'paused'.
 *   - Requires channelManager dep (existing) and tenant context.
 *   - 401 without token; 401 with token but no tenantId.
 *   - 403 without channel.sync.read permission.
 */

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createApp } = require('../src/app');

// ── Mini ChannelManagerCore stub (channel.routes.js guards on channelManager) ──

function makeStubChannelManager() {
  return {
    status() { return { channels: {}, queue: {}, bookings: {} }; },
    registerAdapter() {},
    pushRates() { throw new Error('not_implemented'); },
    pushInventory() { throw new Error('not_implemented'); },
    syncBookings() { throw new Error('not_implemented'); },
    confirmBooking() { throw new Error('not_implemented'); },
    cancelBooking() { throw new Error('not_implemented'); },
  };
}

// ── In-memory channel registry repo ──────────────────────────────────────────

function makeRegistryRepo() {
  const rows = [];
  let seq = 0;

  function _key(tenantId, propertyId, channelCode) {
    return tenantId + '|' + (propertyId || '') + '|' + channelCode;
  }

  return {
    async list({ tenantId, propertyId }) {
      return rows.filter(r => r.tenant_id === tenantId && (r.property_id || '') === (propertyId || ''));
    },
    async findByCode(channelCode, { tenantId, propertyId }) {
      return rows.find(r => r.tenant_id === tenantId && r.channel_code === channelCode &&
        (r.property_id || '') === (propertyId || '')) || null;
    },
    async seed(row) {
      const existing = rows.find(r => r.tenant_id === row.tenant_id &&
        r.channel_code === row.channel_code &&
        (r.property_id || '') === (row.property_id || ''));
      if (existing) return existing;
      const rec = { id: 'REG' + String(++seq).padStart(3, '0'), ...row,
        property_id: row.property_id || null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      rows.push(rec);
      return rec;
    },
    async upsert(row) {
      const idx = rows.findIndex(r => r.tenant_id === row.tenant_id &&
        r.channel_code === row.channel_code &&
        (r.property_id || '') === (row.property_id || ''));
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], display_name: row.display_name,
          commission_pct: row.commission_pct ?? null, updated_at: new Date().toISOString() };
        return rows[idx];
      }
      const rec = { id: 'REG' + String(++seq).padStart(3, '0'), ...row,
        property_id: row.property_id || null,
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

// ── App factory ───────────────────────────────────────────────────────────────

const MANAGER_ID = 'eeeeeeee-eeee-1eee-eeee-eeeeeeeeeeee';
const READER_ID  = 'cccccccc-cccc-1ccc-cccc-cccccccccccc';
const NOAUTH_ID  = 'aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa';

const MANAGER_PERMS = ['channel.sync.read', 'channel.sync.run', 'channel.mapping.read'];
const READER_PERMS  = ['channel.sync.read', 'channel.mapping.read'];
const NOAUTH_PERMS  = [];

function makeApp() {
  const repos   = fx.makeFakeRepos();
  const repo    = makeRegistryRepo();
  const { buildChannelRegistryService } = require('../src/channel-manager/registry/channelRegistryService');
  const channelRegistry = buildChannelRegistryService({ repo });

  repos.identityRepo._seedUser({ id: MANAGER_ID, username: 'manager', tenant_id: fx.TENANT_A }, [], MANAGER_PERMS);
  repos.identityRepo._seedUser({ id: READER_ID,  username: 'reader',  tenant_id: fx.TENANT_A }, [], READER_PERMS);
  repos.identityRepo._seedUser({ id: NOAUTH_ID,  username: 'noauth',  tenant_id: fx.TENANT_A }, [], NOAUTH_PERMS);

  const app = createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo:   repos.tokensRepo,
    channelManager: makeStubChannelManager(),
    channelRegistry,
  });
  return { app, repo, channelRegistry };
}

// ── GET /api/channel/registry ─────────────────────────────────────────────────

test('GET /api/channel/registry: 401 without token', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/channel/registry');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('GET /api/channel/registry: 403 without channel.sync.read', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: NOAUTH_ID, roleCodes: ['front_desk'] });
    const r  = await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

test('GET /api/channel/registry: seeds 8 default channels on first call', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: READER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.data.items));
    assert.equal(r.body.data.items.length, 8);
  } finally { srv.close(); }
});

test('GET /api/channel/registry: QYRVIA_CONNECT is live+enabled; others are not_configured+disabled', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: READER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const items = r.body.data.items;
    const qc = items.find(i => i.channel_code === 'QYRVIA_CONNECT');
    assert.ok(qc, 'QYRVIA_CONNECT must be in list');
    assert.equal(qc.enabled, true);
    assert.equal(qc.status, 'live');
    const others = items.filter(i => i.channel_code !== 'QYRVIA_CONNECT');
    for (const ch of others) {
      assert.equal(ch.enabled, false, `${ch.channel_code} must be disabled`);
      assert.equal(ch.status, 'not_configured', `${ch.channel_code} must be not_configured`);
    }
  } finally { srv.close(); }
});

test('GET /api/channel/registry: all 8 channel codes present', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: READER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const codes = r.body.data.items.map(i => i.channel_code).sort();
    const expected = ['AGODA','AIRBNB','BOOKING_COM','EXPEDIA','GOOGLE','MAKEMYTRIP','QYRVIA_CONNECT','TRIPADVISOR'].sort();
    assert.deepEqual(codes, expected);
  } finally { srv.close(); }
});

// ── GET /api/channel/registry/:channel ───────────────────────────────────────

test('GET /api/channel/registry/BOOKING_COM: returns channel row', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: READER_ID, roleCodes: ['manager'] });
    // Seed first
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r  = await fx.fetchJson(url + '/api/channel/registry/BOOKING_COM', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.channel_code, 'BOOKING_COM');
  } finally { srv.close(); }
});

test('GET /api/channel/registry/UNKNOWN: 404', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: READER_ID, roleCodes: ['manager'] });
    // Seed first
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r  = await fx.fetchJson(url + '/api/channel/registry/DOES_NOT_EXIST', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 404);
  } finally { srv.close(); }
});

// ── POST /api/channel/registry ────────────────────────────────────────────────

test('POST /api/channel/registry: 403 with read-only permission', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: READER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/channel/registry', {
      method: 'POST',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ channel_code: 'CUSTOM_OTA', display_name: 'Custom OTA' }),
    });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

test('POST /api/channel/registry: 400 missing channel_code', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/channel/registry', {
      method: 'POST',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'No Code' }),
    });
    assert.equal(r.status, 400);
  } finally { srv.close(); }
});

test('POST /api/channel/registry: manager adds custom OTA → 201', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/channel/registry', {
      method: 'POST',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ channel_code: 'CUSTOM_OTA', display_name: 'My Custom OTA', commission_pct: 10 }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.channel_code, 'CUSTOM_OTA');
    assert.equal(r.body.data.status, 'not_configured');
    assert.equal(r.body.data.enabled, false);
  } finally { srv.close(); }
});

// ── PATCH /api/channel/registry/:channel/status ──────────────────────────────

test('PATCH /api/channel/registry/AGODA/status: set to configured', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) }); // seed
    const r  = await fx.fetchJson(url + '/api/channel/registry/AGODA/status', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'configured' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'configured');
  } finally { srv.close(); }
});

test('PATCH /api/channel/registry/AGODA/status: 400 for invalid status', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r  = await fx.fetchJson(url + '/api/channel/registry/AGODA/status', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'flying' }),
    });
    assert.equal(r.status, 400);
  } finally { srv.close(); }
});

test('PATCH /api/channel/registry/AGODA/status: 400 for missing status field', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r  = await fx.fetchJson(url + '/api/channel/registry/AGODA/status', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  } finally { srv.close(); }
});

// ── PATCH /api/channel/registry/:channel/toggle ──────────────────────────────

test('PATCH /api/channel/registry/AGODA/toggle: flips enabled', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r = await fx.fetchJson(url + '/api/channel/registry/AGODA/toggle', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    // AGODA starts disabled, so toggling → enabled=true
    assert.equal(r.body.data.enabled, true);
  } finally { srv.close(); }
});

test('PATCH /api/channel/registry/QYRVIA_CONNECT/toggle: disabling live channel → status=paused', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    // QYRVIA_CONNECT starts enabled+live; toggle should disable it and set status=paused
    const r = await fx.fetchJson(url + '/api/channel/registry/QYRVIA_CONNECT/toggle', {
      method: 'PATCH',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.enabled, false);
    assert.equal(r.body.data.status, 'paused');
  } finally { srv.close(); }
});

// ── POST /api/channel/registry/:channel/sync-error ───────────────────────────

test('POST /api/channel/registry/EXPEDIA/sync-error: sets status=error', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r = await fx.fetchJson(url + '/api/channel/registry/EXPEDIA/sync-error', {
      method: 'POST',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'timeout after 30s' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'error');
    assert.ok(r.body.data.last_error);
  } finally { srv.close(); }
});

test('POST /api/channel/registry/EXPEDIA/sync-error: 400 missing error field', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    const r = await fx.fetchJson(url + '/api/channel/registry/EXPEDIA/sync-error', {
      method: 'POST',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  } finally { srv.close(); }
});

// ── POST /api/channel/registry/:channel/sync-ok ──────────────────────────────

test('POST /api/channel/registry/EXPEDIA/sync-ok: sets last_sync_at, clears last_error', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    await fx.fetchJson(url + '/api/channel/registry', { headers: fx.authHeader(tk) });
    // First record an error
    await fx.fetchJson(url + '/api/channel/registry/EXPEDIA/sync-error', {
      method: 'POST',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'network error' }),
    });
    // Then record a sync success
    const r = await fx.fetchJson(url + '/api/channel/registry/EXPEDIA/sync-ok', {
      method: 'POST',
      headers: { ...fx.authHeader(tk), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.last_sync_at);
    assert.equal(r.body.data.last_error, null);
  } finally { srv.close(); }
});
