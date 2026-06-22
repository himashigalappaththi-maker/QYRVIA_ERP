'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildConnectorRegistry } = require('../src/services/connectorRegistry');
const eventBus = require('../src/core/eventBus');

const CTX = { requestId: 'rq-c', tenantId: fx.TENANT_A, propertyId: null, actorId: fx.USER_ID, actorName: 'Jane' };

beforeEach(() => { eventBus.reset(); });

test('list returns the seeded connectors', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  const list = await reg.list(CTX);
  assert.ok(list.find(c => c.code === 'stripe'));
  assert.ok(list.find(c => c.code === 'booking_com'));
});

test('configureConnector persists + emits connector.configured', async () => {
  const r  = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  const out = await reg.configureConnector('stripe', { enabled: true, config_json: { mode: 'test' } }, CTX);
  assert.equal(out.ok, true);
  assert.ok(db.auditRows.find(x => x.event_type === 'connector.configured'));
  const cfg = await reg.getConfig('stripe', CTX);
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.config_json, { mode: 'test' });
});

test('configureConnector rejects unknown code', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  const out = await reg.configureConnector('zzz_unknown', { enabled: true }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'connector_not_found');
});

test('probe returns not_configured when no config row', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  const out = await reg.probeConnector('stripe', CTX);
  assert.equal(out.status, 'not_configured');
});

test('probe returns configured when config present + no adapter registered', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  await reg.configureConnector('stripe', { enabled: true, config_json: {} }, CTX);
  const out = await reg.probeConnector('stripe', CTX);
  assert.equal(out.status, 'configured');
  assert.equal(out.detail, 'adapter_not_registered');
});

test('probe routes through registered adapter', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  await reg.configureConnector('stripe', { enabled: true, config_json: {} }, CTX);
  reg.registerAdapter('stripe', { probe: async () => ({ ok: false, detail: 'missing_key' }) });
  const out = await reg.probeConnector('stripe', CTX);
  assert.equal(out.status, 'not_configured');
  assert.equal(out.detail, 'missing_key');
});

test('healthCheck returns unknown when no adapter', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  await reg.configureConnector('stripe', { enabled: true, config_json: {} }, CTX);
  const out = await reg.healthCheck('stripe', CTX);
  assert.equal(out.status, 'unknown');
});

test('healthCheck routes through registered adapter', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  await reg.configureConnector('stripe', { enabled: true, config_json: {} }, CTX);
  reg.registerAdapter('stripe', { health: async () => ({ ok: true }) });
  const out = await reg.healthCheck('stripe', CTX);
  assert.equal(out.status, 'healthy');
});

test('probe + health write to connector_health_log', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const reg = buildConnectorRegistry({ repo: r.connectorRepo });
  await reg.configureConnector('stripe', { enabled: true, config_json: {} }, CTX);
  reg.registerAdapter('stripe', { probe: async () => ({ ok: true }), health: async () => ({ ok: true }) });
  await reg.probeConnector('stripe', CTX);
  await reg.healthCheck('stripe', CTX);
  const log = r.connectorRepo._healthLog;
  assert.ok(log.find(x => x.kind === 'probe'));
  assert.ok(log.find(x => x.kind === 'health'));
});
