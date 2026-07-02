'use strict';

/** Phase 24 S2 - Channel Mapping Store (in-memory) + subscriber lifecycle integration. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelMappingStore } = require('../src/channel-manager/services/channelMappingStore');
const { buildChannelSubscriber, SUBSCRIBED_EVENTS } = require('../src/channel-manager/services/channelSubscriber');

function fakeBus() {
  const handlers = new Map();
  return {
    subscribe(type, h) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(h);
      return () => handlers.get(type).delete(h);
    },
    async emit(event) { for (const h of (handlers.get(event.event_type) || [])) await h(event); },
    count(type) { return (handlers.get(type) || new Set()).size; }
  };
}

const ev = (type, rid, extra = {}) => ({
  event_type: type, aggregate_id: rid, property_id: 'p1',
  occurred_at: '2026-06-24T10:00:00.000Z',
  payload: Object.assign({ reservation_id: rid }, extra)
});

test('store API: deterministic link / external id / sync state with injected clock', () => {
  let t = 1000;
  const store = buildChannelMappingStore({ clock: () => t });

  assert.equal(store.getChannel('r1'), null);
  assert.equal(store.getSyncState('r1'), null);

  assert.equal(store.linkReservation('r1', 'channel-manager'), true);
  assert.equal(store.getChannel('r1'), 'channel-manager');

  assert.equal(store.setExternalId('r1', 'EXT-9'), true);
  assert.equal(store.getExternalId('r1'), 'EXT-9');

  assert.equal(store.updateSyncState('r1', 'CREATED'), true);
  assert.equal(store.getSyncState('r1'), 'CREATED');
  assert.equal(store.getLastSync('r1'), 1000);

  t = 2000;
  store.updateSyncState('r1', 'UPDATED');
  assert.equal(store.getSyncState('r1'), 'UPDATED');
  assert.equal(store.getLastSync('r1'), 2000);

  // guards
  assert.equal(store.linkReservation(null, 'x'), false);
  assert.equal(store.updateSyncState('r1', null), false);

  assert.deepEqual(store.snapshot('r1'),
    { reservation_id: 'r1', channel: 'channel-manager', external_id: 'EXT-9', sync_state: 'UPDATED', last_sync: 2000 });
  assert.equal(store.size(), 1);
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.getSyncState('r1'), null);
});

test('lifecycle integration: created -> CREATED, updated -> UPDATED, cancelled -> CANCELLED', async () => {
  const store = buildChannelMappingStore({ clock: () => 1 });
  const bus = fakeBus();
  const unsub = buildChannelSubscriber({ eventBus: bus, store });
  try {
    await bus.emit(ev('reservation.created', 'res-1', { status: 'CONFIRMED' }));
    assert.equal(store.getChannel('res-1'), 'channel-manager', 'mapped on create');
    assert.equal(store.getSyncState('res-1'), 'CREATED');

    await bus.emit(ev('reservation.updated', 'res-1'));
    assert.equal(store.getSyncState('res-1'), 'UPDATED');

    await bus.emit(ev('reservation.cancelled', 'res-1'));
    assert.equal(store.getSyncState('res-1'), 'CANCELLED');
  } finally { unsub(); }
});

test('lifecycle integration: check-in / check-out state transitions', async () => {
  const store = buildChannelMappingStore({ clock: () => 1 });
  const bus = fakeBus();
  const unsub = buildChannelSubscriber({ eventBus: bus, store });
  try {
    await bus.emit(ev('reservation.created', 'res-2'));
    await bus.emit(ev('reservation.checked_in', 'res-2'));
    assert.equal(store.getSyncState('res-2'), 'CHECKED_IN');
    await bus.emit(ev('reservation.checked_out', 'res-2'));
    assert.equal(store.getSyncState('res-2'), 'CHECKED_OUT');
  } finally { unsub(); }
});

test('S1 still holds: exactly 5 listeners, captures without throw, idempotent build', async () => {
  const store = buildChannelMappingStore();
  const bus = fakeBus();
  const unsub1 = buildChannelSubscriber({ eventBus: bus, store });
  const unsub2 = buildChannelSubscriber({ eventBus: bus, store }); // idempotent
  try {
    for (const t of SUBSCRIBED_EVENTS) assert.equal(bus.count(t), 1);
    assert.equal(unsub1, unsub2);
    await assert.doesNotReject(bus.emit(ev('reservation.created', 'res-3')));
  } finally { unsub1(); }
});

test('event without reservation_id is a no-op on the store (no throw)', async () => {
  const store = buildChannelMappingStore();
  const bus = fakeBus();
  const unsub = buildChannelSubscriber({ eventBus: bus, store });
  try {
    await bus.emit({ event_type: 'reservation.created', payload: {} }); // no rid resolvable
    assert.equal(store.size(), 0);
  } finally { unsub(); }
});
