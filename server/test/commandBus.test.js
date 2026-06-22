'use strict';

// Env sentinel so config/env.js doesn't refuse to load when tests run in isolation.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';
process.env.LOG_LEVEL    = 'silent';
process.env.NODE_ENV     = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');
const { makeEvent } = require('../src/core/event');

const CTX = { tenantId: '22222222-2222-2222-2222-222222222222', propertyId: null, requestId: 'rq-cmd', actorId: null };

function makeFakeDb() {
  const rows = [];
  return {
    rows,
    async insertAuditEvent(ev) { rows.push(ev); }
  };
}

beforeEach(() => {
  commandBus.reset();
  eventBus.reset();
});

test('dispatch: unregistered command returns command_not_registered', async () => {
  const db = makeFakeDb();
  eventBus.init({ db });
  const r = await commandBus.dispatch('does.not.exist', { foo: 1 }, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'command_not_registered');
});

test('dispatch: unregistered command still writes attempt + failed audit rows', async () => {
  const db = makeFakeDb();
  eventBus.init({ db });
  await commandBus.dispatch('does.not.exist', {}, CTX);
  const types = db.rows.map(r => r.event_type).sort();
  assert.deepEqual(types, ['command.attempted', 'command.failed']);
  const failed = db.rows.find(r => r.event_type === 'command.failed');
  assert.equal(failed.payload.command_name, 'does.not.exist');
  assert.equal(failed.payload.error, 'command_not_registered');
});

test('dispatch: rejects without tenantId', async () => {
  const db = makeFakeDb();
  eventBus.init({ db });
  const r = await commandBus.dispatch('x.y', {}, { tenantId: null, requestId: 'r' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'tenant_required');
  // No audit row because the audit pipeline itself requires tenantId in ctx.
  assert.equal(db.rows.length, 0);
});

test('dispatch: registered handler success path writes attempt + succeeded + event rows', async () => {
  const db = makeFakeDb();
  eventBus.init({ db });
  commandBus.register({
    name: 'demo.create',
    aggregateType: 'demo',
    async handler(input, ctx) {
      return {
        ok: true,
        result: { id: 'd1', x: input.x },
        events: [makeEvent({ type: 'demo.created', aggregateType: 'demo', aggregateId: 'd1', payload: { x: input.x }, ctx })]
      };
    }
  });
  const r = await commandBus.dispatch('demo.create', { x: 7 }, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.result.x, 7);
  const types = db.rows.map(r => r.event_type).sort();
  assert.deepEqual(types, ['command.attempted', 'command.succeeded', 'demo.created']);
});

test('dispatch: handler returning permission_denied is audited as command.denied', async () => {
  const db = makeFakeDb();
  eventBus.init({ db });
  commandBus.register({
    name: 'demo.guarded',
    aggregateType: 'demo',
    async handler() { return { ok: false, error: 'permission_denied' }; }
  });
  const r = await commandBus.dispatch('demo.guarded', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'permission_denied');
  assert.ok(db.rows.find(x => x.event_type === 'command.denied'));
});

test('dispatch: handler throw is captured as failed outcome', async () => {
  const db = makeFakeDb();
  eventBus.init({ db });
  commandBus.register({
    name: 'demo.boom',
    aggregateType: 'demo',
    async handler() { throw new Error('kaboom'); }
  });
  const r = await commandBus.dispatch('demo.boom', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'handler_threw');
  assert.ok(db.rows.find(x => x.event_type === 'command.failed'));
});

test('dispatch: handler returning bad shape -> invalid_handler_outcome', async () => {
  const db = makeFakeDb();
  eventBus.init({ db });
  commandBus.register({
    name: 'demo.bad',
    aggregateType: 'demo',
    async handler() { return 'not an object'; }
  });
  const r = await commandBus.dispatch('demo.bad', {}, CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_handler_outcome');
});

test('list: returns registered command names sorted', () => {
  commandBus.register({ name: 'b.x', handler: async () => ({ ok: true }) });
  commandBus.register({ name: 'a.x', handler: async () => ({ ok: true }) });
  assert.deepEqual(commandBus.list(), ['a.x', 'b.x']);
});

test('register: rejects duplicate name', () => {
  commandBus.register({ name: 'dup.x', handler: async () => ({ ok: true }) });
  assert.throws(() => commandBus.register({ name: 'dup.x', handler: async () => ({ ok: true }) }), /already registered/);
});
