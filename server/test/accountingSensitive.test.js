'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');

const CTX = (locked = false) => ({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-21', businessDateLocked: locked,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
});

function fresh() {
  commandBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  return { db };
}

test('commandBus blocks accountingSensitive commands when businessDateLocked=true', async () => {
  fresh();
  commandBus.register({
    name: 'demo.sensitive', aggregateType: 'demo', accountingSensitive: true,
    async handler() { return { ok: true, result: { ran: true } }; }
  });
  const blocked = await commandBus.dispatch('demo.sensitive', {}, CTX(true));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'business_date_locked');
});

test('commandBus runs accountingSensitive commands when businessDateLocked=false', async () => {
  fresh();
  commandBus.register({
    name: 'demo.sensitive2', aggregateType: 'demo', accountingSensitive: true,
    async handler() { return { ok: true, result: { ran: true } }; }
  });
  const ok = await commandBus.dispatch('demo.sensitive2', {}, CTX(false));
  assert.equal(ok.ok, true);
  assert.equal(ok.result.ran, true);
});

test('commandBus runs non-accountingSensitive commands even when businessDateLocked=true', async () => {
  fresh();
  commandBus.register({
    name: 'demo.harmless', aggregateType: 'demo',  // no flag
    async handler() { return { ok: true, result: { ran: true } }; }
  });
  const ok = await commandBus.dispatch('demo.harmless', {}, CTX(true));
  assert.equal(ok.ok, true);
});

test('commandBus runs accountingSensitive commands when also acceptsBusinessDateLocked=true', async () => {
  fresh();
  commandBus.register({
    name: 'demo.audit_owner', aggregateType: 'demo',
    accountingSensitive: true, acceptsBusinessDateLocked: true,
    async handler() { return { ok: true, result: { ran: true } }; }
  });
  const ok = await commandBus.dispatch('demo.audit_owner', {}, CTX(true));
  assert.equal(ok.ok, true);
});

test('blocked command still produces audit trail', async () => {
  const { db } = fresh();
  commandBus.register({
    name: 'demo.blocked_audit', aggregateType: 'demo', accountingSensitive: true,
    async handler() { return { ok: true, result: {} }; }
  });
  await commandBus.dispatch('demo.blocked_audit', {}, CTX(true));
  // command.attempted + command.failed should be there
  const attempted = db.auditRows.find(x => x.event_type === 'command.attempted');
  const failed    = db.auditRows.find(x => x.event_type === 'command.failed');
  assert.ok(attempted, 'attempted event missing');
  assert.ok(failed, 'failed event missing');
  assert.equal(failed.payload.error, 'business_date_locked');
});
