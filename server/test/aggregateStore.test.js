'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildAggregateStore } = require('../src/core/aggregateStore');
const eventBus = require('../src/core/eventBus');

const CTX = { tenantId: fx.TENANT_A, propertyId: null, requestId: 'rq-agg', actorId: fx.USER_ID, actorName: 'Jane' };

function makeMemoryAggregateRepo() {
  const events = []; // { tenant_id, aggregate_type, aggregate_id, event_version, event_type, payload_json, ... }
  const snapshots = []; // { tenant_id, aggregate_type, aggregate_id, aggregate_version, snapshot_json }
  return {
    _events: events, _snapshots: snapshots,
    async findLatestSnapshot(t, type, id) {
      return snapshots.find(s => s.tenant_id===t && s.aggregate_type===type && s.aggregate_id===id) || null;
    },
    async listAggregateEvents(t, type, id, sinceVersion) {
      return events.filter(e => e.tenant_id===t && e.aggregate_type===type && e.aggregate_id===id && e.event_version > (sinceVersion || 0))
        .sort((a,b) => a.event_version - b.event_version)
        .map(e => ({ event_type: e.event_type, event_version: e.event_version, payload: e.payload_json }));
    },
    async getCurrentVersion(t, type, id) {
      return events.filter(e => e.tenant_id===t && e.aggregate_type===type && e.aggregate_id===id)
        .reduce((m, e) => Math.max(m, e.event_version), 0);
    },
    async appendEventWithVersion(rec) {
      const conflict = events.find(e => e.tenant_id===rec.tenant_id && e.aggregate_type===rec.aggregate_type && e.aggregate_id===rec.aggregate_id && e.event_version===rec.event_version);
      if (conflict) {
        const err = new Error('unique constraint violation'); err.code = '23505';
        throw err;
      }
      events.push(rec);
    },
    async upsertSnapshot(rec) {
      const idx = snapshots.findIndex(s => s.tenant_id===rec.tenant_id && s.aggregate_type===rec.aggregate_type && s.aggregate_id===rec.aggregate_id);
      if (idx >= 0) snapshots[idx] = rec; else snapshots.push(rec);
    }
  };
}

beforeEach(() => { eventBus.reset(); });

test('appendEvents from empty: persists at version 1', async () => {
  const repo = makeMemoryAggregateRepo();
  eventBus.init({ db: { async insertAuditEvent(){}, async insertDomainEvent(){} } });
  const store = buildAggregateStore({ repo });
  const r = await store.appendEvents(CTX, 'reservation', 'r1', 0, [
    { event_type: 'reservation.created', payload: { guestId: 'g1' } }
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.newVersion, 1);
  assert.equal(repo._events.length, 1);
  assert.equal(repo._events[0].event_version, 1);
});

test('appendEvents version_conflict when expectedVersion mismatches', async () => {
  const repo = makeMemoryAggregateRepo();
  eventBus.init({ db: { async insertAuditEvent(){}, async insertDomainEvent(){} } });
  const store = buildAggregateStore({ repo });
  await store.appendEvents(CTX, 'reservation', 'r2', 0, [{ event_type: 'reservation.created', payload: {} }]);
  // wrong expectedVersion
  const r = await store.appendEvents(CTX, 'reservation', 'r2', 0, [{ event_type: 'reservation.updated', payload: {} }]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'version_conflict');
  assert.equal(r.currentVersion, 1);
});

test('appendEvents multiple events increment versions monotonically', async () => {
  const repo = makeMemoryAggregateRepo();
  eventBus.init({ db: { async insertAuditEvent(){}, async insertDomainEvent(){} } });
  const store = buildAggregateStore({ repo });
  const r = await store.appendEvents(CTX, 'res', 'r3', 0, [
    { event_type: 'res.created',    payload: {} },
    { event_type: 'res.confirmed',  payload: {} },
    { event_type: 'res.checked_in', payload: {} }
  ]);
  assert.equal(r.newVersion, 3);
  assert.deepEqual(repo._events.map(e => e.event_version), [1, 2, 3]);
});

test('loadAggregate replays events through reducer', async () => {
  const repo = makeMemoryAggregateRepo();
  eventBus.init({ db: { async insertAuditEvent(){}, async insertDomainEvent(){} } });
  const store = buildAggregateStore({ repo });
  await store.appendEvents(CTX, 'cart', 'c1', 0, [
    { event_type: 'item.added',   payload: { sku: 'A', qty: 1 } },
    { event_type: 'item.added',   payload: { sku: 'B', qty: 2 } },
    { event_type: 'item.removed', payload: { sku: 'A' } }
  ]);
  const reducer = (state, ev) => {
    const s = state || { items: {} };
    if (ev.event_type === 'item.added')   s.items[ev.payload.sku] = (s.items[ev.payload.sku] || 0) + ev.payload.qty;
    if (ev.event_type === 'item.removed') delete s.items[ev.payload.sku];
    return s;
  };
  const r = await store.loadAggregate(CTX, 'cart', 'c1', reducer);
  assert.equal(r.version, 3);
  assert.deepEqual(r.aggregate.items, { B: 2 });
});

test('saveSnapshot + loadAggregate reads snapshot + later events only', async () => {
  const repo = makeMemoryAggregateRepo();
  eventBus.init({ db: { async insertAuditEvent(){}, async insertDomainEvent(){} } });
  const store = buildAggregateStore({ repo });
  await store.appendEvents(CTX, 'doc', 'd1', 0, [
    { event_type: 'doc.created', payload: { title: 'A' } },
    { event_type: 'doc.titled',  payload: { title: 'B' } }
  ]);
  await store.saveSnapshot(CTX, 'doc', 'd1', 2, { title: 'B', words: 100 });
  // Append more events
  await store.appendEvents(CTX, 'doc', 'd1', 2, [
    { event_type: 'doc.titled', payload: { title: 'C' } }
  ]);
  let reduces = 0;
  const reducer = (state, ev) => {
    reduces++;
    return Object.assign({}, state, { title: ev.payload.title || state.title });
  };
  const r = await store.loadAggregate(CTX, 'doc', 'd1', reducer);
  assert.equal(r.version, 3);
  assert.equal(r.aggregate.title, 'C');
  assert.equal(r.aggregate.words, 100, 'snapshot fields preserved');
  assert.equal(reduces, 1, 'reducer ran only for the post-snapshot event');
});

test('appendEvents rejects no_events on empty array', async () => {
  const repo = makeMemoryAggregateRepo();
  eventBus.init({ db: { async insertAuditEvent(){}, async insertDomainEvent(){} } });
  const store = buildAggregateStore({ repo });
  const r = await store.appendEvents(CTX, 't', 'x', 0, []);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_events');
});
