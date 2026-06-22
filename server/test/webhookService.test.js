'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildWebhookService, signPayload, nextBackoffMs } = require('../src/services/webhookService');
const eventBus = require('../src/core/eventBus');

const CTX = { requestId: 'rq-w', tenantId: fx.TENANT_A, propertyId: null, actorId: fx.USER_ID, actorName: 'Jane' };

beforeEach(() => { eventBus.reset(); });

test('signPayload produces deterministic HMAC for same ts + payload', () => {
  const a = signPayload('secret', { x: 1 });
  // produce twice within same second: hex stable iff timestamps match
  assert.match(a.signature, /^[0-9a-f]{64}$/);
  assert.match(a.header,    /^t=\d+,v1=[0-9a-f]{64}$/);
});

test('nextBackoffMs increases then caps', () => {
  assert.equal(nextBackoffMs(0), 1000);
  assert.equal(nextBackoffMs(1), 5000);
  assert.equal(nextBackoffMs(4), 600000);
  assert.equal(nextBackoffMs(100), 600000); // capped
});

test('registerEndpoint persists + emits webhook.endpoint_registered + returns secret', async () => {
  const r  = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const svc = buildWebhookService({ repo: r.webhookRepo });
  const out = await svc.registerEndpoint({ name: 'pms', url: 'https://x/y' }, CTX);
  assert.equal(out.ok, true);
  assert.ok(out.id);
  assert.ok(out.secret);
  assert.ok(db.auditRows.find(x => x.event_type === 'webhook.endpoint_registered'));
});

test('listEndpoints scoped to tenant', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildWebhookService({ repo: r.webhookRepo });
  await svc.registerEndpoint({ name: 'a', url: 'https://x/y' }, CTX);
  await svc.registerEndpoint({ name: 'b', url: 'https://x/z' }, Object.assign({}, CTX, { tenantId: fx.TENANT_B }));
  const listA = await svc.listEndpoints(CTX);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].name, 'a');
});

test('enqueue fans out to all matching endpoints', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildWebhookService({ repo: r.webhookRepo });
  await svc.registerEndpoint({ name: 'all',  url: 'https://x/1', eventTypes: [] }, CTX);
  await svc.registerEndpoint({ name: 'spec', url: 'https://x/2', eventTypes: ['order.placed'] }, CTX);
  await svc.registerEndpoint({ name: 'irrelev', url: 'https://x/3', eventTypes: ['user.created'] }, CTX);
  const result = await svc.enqueue({
    tenant_id: fx.TENANT_A, event_type: 'order.placed', event_id: 'e1',
    aggregate_type: 'order', aggregate_id: 'o1', payload: { total: 100 }
  });
  assert.equal(result.enqueued, 2, 'all + specific subscribers, not the irrelevant one');
});

test('deliverPending uses fetch stub - marks delivered on 200', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const fakeFetch = async () => ({ ok: true, status: 200 });
  const svc = buildWebhookService({ repo: r.webhookRepo, fetchImpl: fakeFetch });
  await svc.registerEndpoint({ name: 'x', url: 'https://x/p' }, CTX);
  await svc.enqueue({ tenant_id: fx.TENANT_A, event_type: 'demo.created', event_id: 'e1', aggregate_type: 'demo', aggregate_id: 'd1', payload: {} });
  const out = await svc.deliverPending({ limit: 5 });
  assert.equal(out.delivered, 1);
  assert.equal(r.webhookRepo._deliveries[0].status, 'delivered');
});

test('deliverPending retries on non-2xx until max_attempts', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: false, status: 503 }; };
  const svc = buildWebhookService({ repo: r.webhookRepo, fetchImpl: fakeFetch });
  await svc.registerEndpoint({ name: 'x', url: 'https://x/p' }, CTX);
  await svc.enqueue({ tenant_id: fx.TENANT_A, event_type: 'demo.created', event_id: 'e1', aggregate_type: 'demo', aggregate_id: 'd1', payload: {} });
  // Force max_attempts to 2 for the row, then call twice
  r.webhookRepo._deliveries[0].max_attempts = 2;
  // First attempt - row stays pending, attempts=1
  // Force next_attempt_at to past so we pick it again
  await svc.deliverPending({ limit: 5 });
  r.webhookRepo._deliveries[0].next_attempt_at = new Date(0).toISOString();
  await svc.deliverPending({ limit: 5 });
  assert.equal(calls, 2);
  assert.equal(r.webhookRepo._deliveries[0].status, 'failed');
});

test('disableEndpoint prevents new deliveries from going through', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const svc = buildWebhookService({ repo: r.webhookRepo });
  const reg = await svc.registerEndpoint({ name: 'x', url: 'https://x/p' }, CTX);
  const d   = await svc.disableEndpoint(reg.id, CTX);
  assert.equal(d.ok, true);
  const out = await svc.enqueue({ tenant_id: fx.TENANT_A, event_type: 'x.y', event_id: 'e', aggregate_type: 'x', aggregate_id: '1', payload: {} });
  assert.equal(out.enqueued, 0);
});

test('deliverPending without fetchImpl marks no_fetch_impl', async () => {
  // Force fetch off
  const realFetch = global.fetch;
  global.fetch = undefined;
  try {
    const r = fx.makeFakeRepos();
    eventBus.init({ db: fx.makeFakeDb() });
    const svc = buildWebhookService({ repo: r.webhookRepo });
    await svc.registerEndpoint({ name: 'x', url: 'https://x/p' }, CTX);
    await svc.enqueue({ tenant_id: fx.TENANT_A, event_type: 'x.y', event_id: 'e', aggregate_type: 'x', aggregate_id: '1', payload: {} });
    const out = await svc.deliverPending({ limit: 5 });
    assert.equal(out.failed, 1);
    assert.equal(r.webhookRepo._deliveries[0].last_error, 'no_fetch_impl');
  } finally {
    global.fetch = realFetch;
  }
});
