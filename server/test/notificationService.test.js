'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildNotificationService } = require('../src/services/notificationService');
const eventBus                     = require('../src/core/eventBus');

const CTX = { requestId: 'rq-n', tenantId: fx.TENANT_A, propertyId: null, actorId: fx.USER_ID, actorName: 'Jane' };

beforeEach(() => { eventBus.reset(); });

test('requestNotification persists pending row + emits notification.requested', async () => {
  const r = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({
    channel: 'email', recipient: 'a@b.c', body: 'hello'
  }, CTX);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'pending');
  assert.equal(r.notificationRepo._notifications[0].channel, 'email');
  assert.ok(db.auditRows.find(x => x.event_type === 'notification.requested'));
});

test('requestNotification rejects missing channel', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ recipient: 'a@b.c', body: 'x' }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'missing_fields');
});

test('requestNotification rejects invalid channel', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ channel: 'pigeon', recipient: 'x', body: 'y' }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'invalid_channel');
});

test('renders template variables', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  r.notificationRepo._seedTemplate({
    id:'tpl1', tenant_id: fx.TENANT_A, code:'welcome', channel:'email',
    subject:'Hi {{name}}', body:'Welcome {{name}} to {{hotel}}', is_active:true
  });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({
    channel: 'email', recipient: 'a@b.c', templateCode: 'welcome',
    context: { name: 'Jane', hotel: 'Acme' }
  }, CTX);
  assert.equal(out.ok, true);
  const n = r.notificationRepo._notifications[0];
  assert.equal(n.subject, 'Hi Jane');
  assert.equal(n.body,    'Welcome Jane to Acme');
});

test('sendPending without provider marks not_configured + writes delivery log', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  await svc.requestNotification({ channel:'email', recipient:'a@b.c', body:'x' }, CTX);
  const out = await svc.sendPending({ limit: 5 });
  assert.equal(out.attempted, 1);
  assert.equal(out.notConfigured, 1);
  assert.equal(r.notificationRepo._notifications[0].status, 'not_configured');
  assert.equal(r.notificationRepo._deliveryLog[0].status, 'not_configured');
});

test('sendPending with provider success marks delivered', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  svc.registerProvider('email', { async send() { return { ok: true, provider:'memory', provider_ref:'msg-1' }; } });
  await svc.requestNotification({ channel:'email', recipient:'a@b.c', body:'x' }, CTX);
  const out = await svc.sendPending({ limit: 5 });
  assert.equal(out.delivered, 1);
  assert.equal(r.notificationRepo._notifications[0].status, 'delivered');
});

test('sendPending with provider failure marks failed', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  svc.registerProvider('email', { async send() { return { ok: false, error: 'smtp_timeout' }; } });
  await svc.requestNotification({ channel:'email', recipient:'a@b.c', body:'x' }, CTX);
  const out = await svc.sendPending({ limit: 5 });
  assert.equal(out.failed, 1);
  assert.equal(r.notificationRepo._notifications[0].status, 'failed');
  assert.equal(r.notificationRepo._deliveryLog[0].error, 'smtp_timeout');
});

test('tenant isolation: tenant B cannot see tenant A notifications', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ channel:'email', recipient:'a@b.c', body:'x' }, CTX);
  const otherCtx = Object.assign({}, CTX, { tenantId: fx.TENANT_B });
  const found = await svc.findById(out.id, otherCtx);
  assert.equal(found, null);
});

test('list filters by status', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  await svc.requestNotification({ channel:'email', recipient:'a@b.c', body:'1' }, CTX);
  await svc.requestNotification({ channel:'email', recipient:'a@b.c', body:'2' }, CTX);
  await svc.sendPending({ limit: 10 }); // marks both not_configured
  const all = await svc.list(CTX, {});
  const notCfg = await svc.list(CTX, { status: 'not_configured' });
  assert.equal(all.length, 2);
  assert.equal(notCfg.length, 2);
});

test('empty body without template -> empty_body', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildNotificationService({ repo: r.notificationRepo });
  const out = await svc.requestNotification({ channel:'email', recipient:'a@b.c' }, CTX);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'empty_body');
});
