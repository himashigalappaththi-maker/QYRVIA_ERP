'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const queryBus = require('../src/core/queryBus');
const eventBus = require('../src/core/eventBus');

const CTX = {
  requestId: 'rq-q', tenantId: fx.TENANT_A, propertyId: null,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: [], roleIds: [], permissions: []
};

beforeEach(() => { queryBus.reset(); eventBus.reset(); });

test('execute: unregistered query returns query_not_registered', async () => {
  const r = await queryBus.execute('does.not.exist', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'query_not_registered');
});

test('execute: rejects without tenantId', async () => {
  queryBus.register({ name: 'demo.list', resourceType: 'demo', handler: async () => ({ ok:true, data:[] }) });
  const r = await queryBus.execute('demo.list', {}, { requestId: 'r', tenantId: null });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'tenant_required');
});

test('execute: permission required + missing -> permission_denied', async () => {
  queryBus.register({ name: 'demo.read', resourceType: 'demo', permission: 'demo.read', handler: async () => ({ ok:true, data:[] }) });
  const r = await queryBus.execute('demo.read', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'permission_denied');
});

test('execute: permission present -> handler runs', async () => {
  queryBus.register({ name: 'demo.read2', resourceType: 'demo', permission: 'demo.read', handler: async () => ({ ok:true, data:[1,2,3] }) });
  const ctx = Object.assign({}, CTX, { permissions: ['demo.read'] });
  const r = await queryBus.execute('demo.read2', {}, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, [1,2,3]);
});

test('execute: super_admin bypasses permission', async () => {
  queryBus.register({ name: 'demo.super', resourceType: 'demo', permission: 'whatever.exotic', handler: async () => ({ ok:true, data:'ok' }) });
  const ctx = Object.assign({}, CTX, { roleCodes: ['super_admin'] });
  const r = await queryBus.execute('demo.super', {}, ctx);
  assert.equal(r.ok, true);
});

test('execute: audited:true emits query.run event to audit', async () => {
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  queryBus.register({
    name: 'demo.audited',
    resourceType: 'demo',
    audited: true,
    handler: async () => ({ ok:true, data:'x' })
  });
  await queryBus.execute('demo.audited', { foo: 1 }, CTX);
  const row = db.auditRows.find(x => x.event_type === 'query.run');
  assert.ok(row, 'expected query.run audit row');
  assert.equal(row.tenant_id, fx.TENANT_A);
  assert.equal(row.payload.query_name, 'demo.audited');
});

test('execute: unaudited query does NOT write audit row', async () => {
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  queryBus.register({ name: 'demo.silent', resourceType: 'demo', handler: async () => ({ ok:true, data:[] }) });
  await queryBus.execute('demo.silent', {}, CTX);
  assert.equal(db.auditRows.length, 0, 'no audit row for unaudited reads');
});

test('execute: handler throw -> handler_threw outcome', async () => {
  queryBus.register({ name: 'demo.boom', resourceType: 'demo', handler: async () => { throw new Error('kaboom'); } });
  const r = await queryBus.execute('demo.boom', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'handler_threw');
});

test('execute: invalid handler outcome shape -> invalid_handler_outcome', async () => {
  queryBus.register({ name: 'demo.bad', resourceType: 'demo', handler: async () => 'not an object' });
  const r = await queryBus.execute('demo.bad', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_handler_outcome');
});

test('register: rejects duplicate name', () => {
  queryBus.register({ name: 'demo.dup', resourceType: 'demo', handler: async () => ({ ok:true, data:[] }) });
  assert.throws(() => queryBus.register({ name: 'demo.dup', resourceType: 'demo', handler: async () => ({ ok:true, data:[] }) }), /already registered/);
});
