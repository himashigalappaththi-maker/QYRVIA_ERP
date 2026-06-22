'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const eventBus = require('../src/core/eventBus');
const { buildSettings, registerSpec, listCatalog, lookupSpec, _resetCatalog } = require('../src/services/settingsService');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], permissions: []
}, overrides);

function fresh() {
  eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  _resetCatalog();
  const repos = fx.makeFakeRepos();
  const svc   = buildSettings({ repo: repos.settingsRepo });
  return { db, svc };
}

test('registerSpec + lookupSpec round-trip', () => {
  fresh();
  registerSpec('demo', 'flag', { value_type: 'boolean', default_value_json: true, description: 'demo flag' });
  const spec = lookupSpec('demo', 'flag');
  assert.equal(spec.category, 'demo');
  assert.equal(spec.key, 'flag');
  assert.equal(spec.value_type, 'boolean');
});

test('listCatalog filters by category and sorts deterministically', () => {
  fresh();
  registerSpec('zz', 'b', { value_type: 'string' });
  registerSpec('aa', 'a', { value_type: 'string' });
  registerSpec('aa', 'b', { value_type: 'string' });
  const all = listCatalog();
  assert.deepEqual(all.map((s) => s.category + '.' + s.key), ['aa.a','aa.b','zz.b']);
  const onlyAa = listCatalog('aa');
  assert.equal(onlyAa.length, 2);
  assert.ok(onlyAa.every((s) => s.category === 'aa'));
});

test('set: registered boolean accepts true / rejects "true"', async () => {
  const { svc } = fresh();
  registerSpec('demo', 'flag', { value_type: 'boolean' });
  const good = await svc.set('demo', 'flag', true, { ctx: CTX() });
  assert.equal(good.ok, true);
  const bad  = await svc.set('demo', 'flag', 'true', { ctx: CTX() });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'setting_invalid_type');
});

test('set: registered enum rejects out-of-range value', async () => {
  const { svc } = fresh();
  registerSpec('demo', 'mode', { value_type: 'enum', enum_values: ['A','B','C'] });
  const good = await svc.set('demo', 'mode', 'B', { ctx: CTX() });
  assert.equal(good.ok, true);
  const bad  = await svc.set('demo', 'mode', 'Z', { ctx: CTX() });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'setting_invalid_enum');
});

test('set: registered int honours min/max', async () => {
  const { svc } = fresh();
  registerSpec('demo', 'n', { value_type: 'int', min: 1, max: 10 });
  assert.equal((await svc.set('demo','n',  5, { ctx: CTX() })).ok, true);
  assert.equal((await svc.set('demo','n',  0, { ctx: CTX() })).error, 'setting_below_min');
  assert.equal((await svc.set('demo','n', 11, { ctx: CTX() })).error, 'setting_above_max');
  assert.equal((await svc.set('demo','n','5', { ctx: CTX() })).error, 'setting_invalid_type');
});

test('set: UNREGISTERED key still accepted (BC) + emits settings.unregistered_key event', async () => {
  const { db, svc } = fresh();
  const r = await svc.set('not_registered', 'random', 42, { ctx: CTX() });
  assert.equal(r.ok, true);
  const ev = db.auditRows.find(x => x.event_type === 'settings.unregistered_key');
  assert.ok(ev, 'expected unregistered_key audit event');
});

test('set: rejected catalog write emits settings.set_rejected audit event', async () => {
  const { db, svc } = fresh();
  registerSpec('demo', 'flag', { value_type: 'boolean' });
  await svc.set('demo', 'flag', 'oops', { ctx: CTX() });
  const ev = db.auditRows.find(x => x.event_type === 'settings.set_rejected');
  assert.ok(ev, 'expected settings.set_rejected audit event');
  assert.equal(ev.payload.error, 'setting_invalid_type');
});

test('bootstrapSettingsCatalog registers known platform tunables', () => {
  fresh();
  const { bootstrapSettingsCatalog } = require('../src/services/settingsCatalogBoot');
  bootstrapSettingsCatalog();
  // Spot-check the most important keys from §1-§5 of the assessment.
  assert.ok(lookupSpec('night_audit', 'cron'));
  assert.ok(lookupSpec('night_audit', 'stale_threshold_hours'));
  assert.ok(lookupSpec('multi_property', 'switcher_remember_choice'));
  assert.ok(lookupSpec('ai', 'default_provider'));
  // AI provider must be an enum — no fake providers permitted.
  const ai = lookupSpec('ai', 'default_provider');
  assert.equal(ai.value_type, 'enum');
  assert.ok(ai.enum_values.includes('anthropic'));
  assert.ok(!ai.enum_values.includes('mock'));
});
