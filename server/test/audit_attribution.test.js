'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert   = require('node:assert/strict');

const { createApp } = require('../src/app');
const commandBus    = require('../src/core/commandBus');
const eventBus      = require('../src/core/eventBus');
const { makeEvent } = require('../src/core/event');

beforeEach(() => {
  commandBus.reset();
  eventBus.reset();
});

test('command audit rows carry actor_id + tenant_id + request_id from JWT', async () => {
  const repos = fx.makeFakeRepos();
  const db    = fx.makeFakeDb();
  const app   = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });

  // register a tiny success command
  commandBus.register({
    name: 'attribution.demo',
    aggregateType: 'demo',
    async handler(input, ctx) {
      return { ok: true, result: { id: 'x' }, events: [
        makeEvent({ type: 'demo.created', aggregateType: 'demo', aggregateId: 'x', payload: {}, ctx })
      ]};
    }
  });

  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: fx.USER_ID, tenantId: fx.TENANT_A, roleCodes: ['corporate_admin'] });
    const r = await fx.fetchJson(url + '/api/core/commands/attribution.demo', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({})
    });
    assert.equal(r.status, 200);
    // Look at every audit row produced
    const requestId = r.body.requestId;
    assert.match(requestId, /.+/);
    const eventTypes = db.auditRows.map(x => x.event_type).sort();
    assert.deepEqual(eventTypes, ['command.attempted', 'command.succeeded', 'demo.created']);
    // Every row carries the JWT tenant and actor (not header-supplied)
    for (const row of db.auditRows) {
      assert.equal(row.tenant_id, fx.TENANT_A);
      assert.equal(row.actor_id,  fx.USER_ID);
      assert.equal(row.request_id, requestId);
    }
  } finally { srv.close(); }
});

test('event factory refuses to build an event without tenantId/requestId in ctx', () => {
  assert.throws(() => makeEvent({
    type: 'x.y', aggregateType: 'x', aggregateId: '1', payload: {}, ctx: { tenantId: null, requestId: 'r' }
  }));
  assert.throws(() => makeEvent({
    type: 'x.y', aggregateType: 'x', aggregateId: '1', payload: {}, ctx: { tenantId: 't', requestId: null }
  }));
});

test('actor_name flows into command audit payload', async () => {
  const repos = fx.makeFakeRepos();
  const db    = fx.makeFakeDb();
  eventBus.init({ db });
  commandBus.register({
    name: 'name.demo', aggregateType: 'demo',
    async handler() { return { ok: true, result: {} }; }
  });
  await commandBus.dispatch('name.demo', {}, {
    requestId: 'r', tenantId: fx.TENANT_A, propertyId: null,
    actorId: fx.USER_ID, actorName: 'Jane Doe', roleCodes: [], roleIds: [], permissions: []
  });
  const attempt = db.auditRows.find(x => x.event_type === 'command.attempted');
  assert.equal(attempt.payload.actor_name, 'Jane Doe');
});
