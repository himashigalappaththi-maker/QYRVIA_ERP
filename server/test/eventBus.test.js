'use strict';

// Env sentinel so config/env.js doesn't refuse to load when tests run in isolation.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';
process.env.LOG_LEVEL    = 'silent';
process.env.NODE_ENV     = 'test';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const eventBus = require('../src/core/eventBus');
const { makeEvent } = require('../src/core/event');

const CTX = { tenantId: '11111111-1111-1111-1111-111111111111', propertyId: null, requestId: 'rq-test', actorId: null };

function makeFakeDb() {
  const rows = [];
  return {
    rows,
    async insertAuditEvent(ev) { rows.push(ev); }
  };
}

function mkEvent(type, agg) {
  return makeEvent({
    type, aggregateType: type.split('.')[0], aggregateId: agg || 'a1',
    payload: { hello: 'world' }, ctx: CTX
  });
}

test('makeEvent: enforces <aggregate>.<verb> name', () => {
  assert.throws(() => makeEvent({ type: 'NoDot', aggregateType: 'x', aggregateId: 'y', ctx: CTX }));
  assert.throws(() => makeEvent({ type: 'two.dots.bad', aggregateType: 'x', aggregateId: 'y', ctx: CTX }));
  assert.doesNotThrow(() => makeEvent({ type: 'reservation.created', aggregateType: 'reservation', aggregateId: 'y', ctx: CTX }));
});

test('makeEvent: requires tenantId + requestId in ctx', () => {
  assert.throws(() => makeEvent({ type: 'x.y', aggregateType: 'x', aggregateId: 'z', ctx: { tenantId: null, requestId: 'r' } }));
  assert.throws(() => makeEvent({ type: 'x.y', aggregateType: 'x', aggregateId: 'z', ctx: { tenantId: 't', requestId: null } }));
});

test('eventBus: publish writes to audit subscriber first', async () => {
  eventBus.reset();
  const db = makeFakeDb();
  eventBus.init({ db });
  let seenByUserSub = false;
  eventBus.subscribe('test.thing', () => { seenByUserSub = true; });
  await eventBus.publish(mkEvent('test.thing'));
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].event_type, 'test.thing');
  assert.equal(seenByUserSub, true);
});

test('eventBus: wildcard subscriber gets every event', async () => {
  eventBus.reset();
  eventBus.init({ db: makeFakeDb() });
  const seen = [];
  eventBus.subscribe('*', (ev) => { seen.push(ev.event_type); });
  await eventBus.publish(mkEvent('a.one'));
  await eventBus.publish(mkEvent('b.two'));
  assert.deepEqual(seen, ['a.one', 'b.two']);
});

test('eventBus: subscriber error does NOT prevent audit write or other subscribers', async () => {
  eventBus.reset();
  const db = makeFakeDb();
  eventBus.init({ db });
  let other = false;
  eventBus.subscribe('boom.x', () => { throw new Error('subscriber boom'); });
  eventBus.subscribe('boom.x', () => { other = true; });
  await eventBus.publish(mkEvent('boom.x'));
  assert.equal(db.rows.length, 1);
  assert.equal(other, true);
});

test('eventBus: persistence failure propagates up to publisher', async () => {
  eventBus.reset();
  const failingDb = { async insertAuditEvent() { throw new Error('db_down'); } };
  eventBus.init({ db: failingDb });
  await assert.rejects(eventBus.publish(mkEvent('fail.x')), /db_down/);
});

test('eventBus: unsubscribe stops delivery', async () => {
  eventBus.reset();
  eventBus.init({ db: makeFakeDb() });
  let count = 0;
  const off = eventBus.subscribe('on.off', () => { count++; });
  await eventBus.publish(mkEvent('on.off'));
  off();
  await eventBus.publish(mkEvent('on.off'));
  assert.equal(count, 1);
});
