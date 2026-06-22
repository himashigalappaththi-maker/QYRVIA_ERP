'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const eventBus      = require('../src/core/eventBus');
const { makeEvent } = require('../src/core/event');

const CTX = { tenantId: fx.TENANT_A, propertyId: null, requestId: 'rq-es', actorId: fx.USER_ID };

function makeRichDb() {
  const audit = [], store = [];
  return {
    auditRows: audit,
    storeRows: store,
    async insertAuditEvent(ev) { audit.push(ev); },
    async insertDomainEvent(ev) { store.push(ev); }
  };
}

beforeEach(() => { eventBus.reset(); });

test('domain event lands in BOTH audit_events AND event_store', async () => {
  const db = makeRichDb();
  eventBus.init({ db });
  await eventBus.publish(makeEvent({
    type:'demo.created', aggregateType:'demo', aggregateId:'d1',
    payload:{ x: 1 }, ctx: CTX
  }));
  assert.equal(db.auditRows.length, 1);
  assert.equal(db.storeRows.length, 1);
  assert.equal(db.storeRows[0].event_type, 'demo.created');
});

test('command.* / query.* events do NOT write to event_store (audit-only)', async () => {
  const db = makeRichDb();
  eventBus.init({ db });
  await eventBus.publish(makeEvent({ type:'command.attempted', aggregateType:'command', aggregateId:'c1', payload:{}, ctx: CTX }));
  await eventBus.publish(makeEvent({ type:'query.run',          aggregateType:'query',   aggregateId:'q1', payload:{}, ctx: CTX }));
  assert.equal(db.auditRows.length, 2);
  assert.equal(db.storeRows.length, 0, 'command/query events must not pollute event_store');
});

test('publish FAILS if event_store insert throws (mandatory persistence)', async () => {
  const failing = {
    async insertAuditEvent() {},
    async insertDomainEvent() { throw new Error('event_store_down'); }
  };
  eventBus.init({ db: failing });
  await assert.rejects(eventBus.publish(makeEvent({
    type: 'demo.created', aggregateType:'demo', aggregateId:'d1', payload:{}, ctx: CTX
  })), /event_store_down/);
});

test('publish FAILS if audit_events insert throws (Phase 1 behaviour preserved)', async () => {
  const failing = {
    async insertAuditEvent() { throw new Error('audit_down'); },
    async insertDomainEvent() {}
  };
  eventBus.init({ db: failing });
  await assert.rejects(eventBus.publish(makeEvent({
    type:'demo.created', aggregateType:'demo', aggregateId:'d1', payload:{}, ctx: CTX
  })), /audit_down/);
});

test('event_store row carries tenant_id + payload', async () => {
  const db = makeRichDb();
  eventBus.init({ db });
  await eventBus.publish(makeEvent({
    type:'order.placed', aggregateType:'order', aggregateId:'o42',
    payload:{ total: 1234 }, ctx: CTX
  }));
  const row = db.storeRows[0];
  assert.equal(row.tenant_id,  fx.TENANT_A);
  assert.equal(row.aggregate_id, 'o42');
  assert.deepEqual(row.payload, { total: 1234 });
});
