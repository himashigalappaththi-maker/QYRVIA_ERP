'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildSettings } = require('../src/services/settingsService');
const eventBus          = require('../src/core/eventBus');

const CTX = {
  requestId: 'rq-s', tenantId: fx.TENANT_A, propertyId: null,
  actorId: fx.USER_ID, actorName: 'Jane'
};
const CTX_OTHER = Object.assign({}, CTX, { tenantId: fx.TENANT_B });

beforeEach(() => { eventBus.reset(); });

test('set + get round-trip at tenant scope', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildSettings({ repo: r.settingsRepo });
  await svc.set('email', 'from_address', { value: 'ops@hotel.com' }, { ctx: CTX });
  const v = await svc.get('email', 'from_address', { ctx: CTX });
  assert.deepEqual(v, { value: 'ops@hotel.com' });
});

test('property-scoped value overrides tenant-wide value', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildSettings({ repo: r.settingsRepo });
  await svc.set('checkin', 'time', { value: '14:00' }, { ctx: CTX });
  const propCtx = Object.assign({}, CTX, { propertyId: fx.PROP_ID });
  await svc.set('checkin', 'time', { value: '13:00' }, { ctx: propCtx, scope: 'property' });
  const vTenant = await svc.get('checkin', 'time', { ctx: CTX });
  const vProp   = await svc.get('checkin', 'time', { ctx: propCtx });
  assert.deepEqual(vTenant, { value: '14:00' });
  assert.deepEqual(vProp,   { value: '13:00' });
});

test('tenant isolation: tenant B cannot see tenant A settings', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildSettings({ repo: r.settingsRepo });
  await svc.set('billing', 'rate', { v: 100 }, { ctx: CTX });
  const v = await svc.get('billing', 'rate', { ctx: CTX_OTHER, default: '__missing__' });
  assert.equal(v, '__missing__');
});

test('set writes a setting.updated event to audit', async () => {
  const r  = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const svc = buildSettings({ repo: r.settingsRepo });
  await svc.set('email', 'from', 'ops@x', { ctx: CTX });
  const row = db.auditRows.find(x => x.event_type === 'setting.updated');
  assert.ok(row);
  assert.equal(row.tenant_id, fx.TENANT_A);
  assert.equal(row.payload.actor_name, 'Jane');
});

test('default value returned when no row exists', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildSettings({ repo: r.settingsRepo });
  const v = await svc.get('missing', 'k', { ctx: CTX, default: 42 });
  assert.equal(v, 42);
});

test('delete removes the row and emits setting.deleted', async () => {
  const r = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const svc = buildSettings({ repo: r.settingsRepo });
  await svc.set('x', 'y', 'z', { ctx: CTX });
  const d = await svc.delete('x', 'y', { ctx: CTX });
  assert.equal(d.ok, true);
  const v = await svc.get('x', 'y', { ctx: CTX });
  assert.equal(v, null);
  assert.ok(db.auditRows.find(r => r.event_type === 'setting.deleted'));
});

test('list returns only this tenant\'s rows', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildSettings({ repo: r.settingsRepo });
  await svc.set('cat', 'a', 1, { ctx: CTX });
  await svc.set('cat', 'b', 2, { ctx: CTX });
  await svc.set('cat', 'a', 9, { ctx: CTX_OTHER });
  const rowsA = await svc.list('cat', { ctx: CTX });
  const rowsB = await svc.list('cat', { ctx: CTX_OTHER });
  assert.equal(rowsA.length, 2);
  assert.equal(rowsB.length, 1);
});
