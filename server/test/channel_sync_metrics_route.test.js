'use strict';

/**
 * Phase 53 H4 — Per-channel sync health in HTTP response.
 * Tests syncMonitor injection into buildChannelController and the syncHealth endpoint.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// ── Fake syncMonitor ──────────────────────────────────────────────────────────

function fakeSyncMonitor(overrides = {}) {
  const health = overrides.health || (() => ({ status: 'degraded', consecutiveFailures: 3, lastOkAt: null, lastError: 'timeout' }));
  return { health };
}

function downSyncMonitor() {
  return {
    health: () => ({ status: 'down', consecutiveFailures: 5, lastOkAt: null, lastError: 'conn_refused' })
  };
}

// ── Stub channel manager that returns channels in status ──────────────────────

function makeStubChannelManager(channels = {}) {
  return {
    status() {
      return { channels, queue: {}, bookings: {} };
    },
    registerAdapter() {},
    pushRates() { throw new Error('not_implemented'); },
    pushInventory() { throw new Error('not_implemented'); },
    syncBookings() { throw new Error('not_implemented'); },
    confirmBooking() { throw new Error('not_implemented'); },
    cancelBooking() { throw new Error('not_implemented'); },
  };
}

// ── User IDs & permissions ────────────────────────────────────────────────────

const READER_ID  = 'eeeeeeee-eeee-1eee-eeee-eeeeeeeeeeee';
const NOAUTH_ID  = 'ffffffff-ffff-1fff-ffff-ffffffffffff';
const READER_PERMS  = ['channel.sync.read', 'channel.mapping.read'];
const NOAUTH_PERMS  = [];

function makeApp({ syncMonitor, channelManagerOverride } = {}) {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: READER_ID, username: 'reader', tenant_id: fx.TENANT_A }, [], READER_PERMS);
  repos.identityRepo._seedUser({ id: NOAUTH_ID, username: 'noauth', tenant_id: fx.TENANT_A }, [], NOAUTH_PERMS);

  const channels = { QYRVIA_CONNECT: { real: true }, BOOKING_COM: { real: false } };
  const channelManager = channelManagerOverride || makeStubChannelManager(channels);

  // channelOutboundSync is expected to have .syncMonitor
  const channelOutboundSync = syncMonitor != null ? { syncMonitor } : null;

  return createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo: repos.tokensRepo,
    channelManager,
    channelOutboundSync,
  });
}

// ── 1. syncMonitor injected → health field per channel ────────────────────────

test('syncHealth: with syncMonitor, each channel in response has health field', async () => {
  const monitor = fakeSyncMonitor();
  const app = makeApp({ syncMonitor: monitor });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: READER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/channel/sync-health', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    const channels = r.body.data.channels;
    // Every channel entry should have a health field
    for (const [ch, chData] of Object.entries(channels || {})) {
      assert.ok('health' in chData, `channel ${ch} missing health field`);
      assert.ok('status' in chData.health, `channel ${ch} health missing status`);
      assert.ok('consecutiveFailures' in chData.health, `channel ${ch} health missing consecutiveFailures`);
      assert.ok('lastOkAt' in chData.health, `channel ${ch} health missing lastOkAt`);
    }
  } finally { srv.close(); }
});

// ── 2. No syncMonitor → no health field (backward compat) ─────────────────────

test('syncHealth: without syncMonitor, no health field attached (backward compat)', async () => {
  const app = makeApp({ syncMonitor: null });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: READER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/channel/sync-health', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    const channels = r.body.data.channels || {};
    for (const chData of Object.values(channels)) {
      assert.ok(!('health' in chData), 'health field must not be present without syncMonitor');
    }
  } finally { srv.close(); }
});

// ── 3. Down threshold: >= 3 failures → status 'down' ─────────────────────────

test('syncMonitor health: consecutiveFailures >= 3 → status down', () => {
  const { buildSyncMonitor } = require('../src/channel-manager/ota/monitoring');
  const monitor = buildSyncMonitor();

  // Record 3 consecutive failures
  monitor.recordAttempt({ tenant_id: 't1', channel: 'BOOKING_COM', op: 'pushRate', ok: false });
  monitor.recordAttempt({ tenant_id: 't1', channel: 'BOOKING_COM', op: 'pushRate', ok: false });
  monitor.recordAttempt({ tenant_id: 't1', channel: 'BOOKING_COM', op: 'pushRate', ok: false });

  const h = monitor.health('BOOKING_COM');
  assert.equal(h.status, 'down');
  assert.equal(h.consecutiveFailures, 3);
});

// ── 4. syncHealth route auth: 401 without token ──────────────────────────────

test('syncHealth: 401 without token', async () => {
  const app = makeApp({});
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/channel/sync-health');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

// ── 5. syncHealth route auth: 403 without channel.sync.read permission ────────

test('syncHealth: 403 without channel.sync.read permission', async () => {
  const app = makeApp({});
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: NOAUTH_ID, roleCodes: ['front_desk'] });
    const r  = await fx.fetchJson(url + '/api/channel/sync-health', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});
