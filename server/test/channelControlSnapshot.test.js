'use strict';

/** Phase 25 - control-center snapshot: non-secret operational status aggregation. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildControlSnapshot } = require('../src/channel-manager/api/controlSnapshot');

const CTX = { tenantId: 't1', requestId: 'rq' };
const ENV = { CHANNEL_HTTP_ENABLED: 'false', CHANNEL_WORKER_ENABLED: 'false', CHANNEL_WEBHOOK_ENABLED: 'false' };

function fullDeps() {
  return {
    channelManager: { status: () => ({ channels: [{ channel: 'QYRVIA_CONNECT', qyrvia_owned: true, commissionPct: 0 }], queue: { size: 2, deadLetter: 0 }, bookings: 3 }) },
    channelOutboundSync: { realChannels: new Set(['QYRVIA_CONNECT']), httpChannels: [] },
    channelMapping: { service: { listMappings: (f) => (f.tenant_id === 't1' ? [{}, {}] : []) } },
    channelCredentials: { hasProvider: false },
    channelPersistence: { mode: 'memory' }
  };
}

test('snapshot aggregates non-secret status from all subsystems', () => {
  const snap = buildControlSnapshot(fullDeps(), CTX, ENV);
  assert.equal(snap.channels.length, 1);
  assert.equal(snap.channels[0].channel, 'QYRVIA_CONNECT');
  assert.equal(snap.queue.size, 2);
  assert.equal(snap.bookings, 3);
  assert.deepEqual(snap.sync.realChannels, ['QYRVIA_CONNECT']);
  assert.deepEqual(snap.sync.httpChannels, []);
  assert.equal(snap.sync.httpEnabled, false);
  assert.equal(snap.persistence.mode, 'memory');
  assert.equal(snap.credentials.providerActive, false);
  assert.equal(snap.worker.enabled, false);
  assert.equal(snap.webhook.enabled, false);
  assert.equal(snap.mappings.count, 2);
});

test('snapshot never exposes secrets/credential payloads', () => {
  const deps = fullDeps();
  deps.channelCredentials = { hasProvider: true, provider: { get: () => ({ api_key: 'SECRET' }) } };
  const snap = buildControlSnapshot(deps, CTX, ENV);
  assert.equal(snap.credentials.providerActive, true);
  assert.ok(!JSON.stringify(snap).includes('SECRET'));
  assert.equal(snap.credentials.api_key, undefined);
});

test('snapshot is resilient to missing subsystems (graceful partial)', () => {
  const snap = buildControlSnapshot({}, CTX, {});
  assert.deepEqual(snap.channels, []);
  assert.equal(snap.queue, null);
  assert.equal(snap.persistence.mode, 'memory');
  assert.equal(snap.sync.realChannels.length, 0);
  assert.equal(snap.worker.enabled, false);
  assert.equal(snap.mappings.count, null);
});

test('flags reflect env truthiness', () => {
  const snap = buildControlSnapshot(fullDeps(), CTX, { CHANNEL_HTTP_ENABLED: 'true', CHANNEL_WORKER_ENABLED: 'true', CHANNEL_WEBHOOK_ENABLED: 'true' });
  assert.equal(snap.sync.httpEnabled, true);
  assert.equal(snap.worker.enabled, true);
  assert.equal(snap.webhook.enabled, true);
});
