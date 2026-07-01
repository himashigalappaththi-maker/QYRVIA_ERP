'use strict';

/** Phase 24 S1 - Channel Manager event spine (subscriber + router). Pure, isolated. */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/channel-manager/services/channelEventRouter');
const { buildChannelSubscriber, normalize, SUBSCRIBED_EVENTS } = require('../src/channel-manager/services/channelSubscriber');

// Minimal fake bus mirroring eventBus.subscribe(type, handler) -> unsubscribe().
function fakeBus() {
  const handlers = new Map();
  return {
    handlers,
    subscribe(type, h) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(h);
      return () => handlers.get(type).delete(h);
    },
    async emit(event) {
      const set = handlers.get(event.event_type) || new Set();
      for (const h of set) await h(event);
    },
    count(type) { return (handlers.get(type) || new Set()).size; }
  };
}

test('router maps every PMS event deterministically; unknown -> null', () => {
  assert.equal(router.actionFor('reservation.created'), 'CREATE_BOOKING');
  assert.equal(router.actionFor('reservation.updated'), 'UPDATE_BOOKING');
  assert.equal(router.actionFor('reservation.cancelled'), 'CANCEL_BOOKING');
  assert.equal(router.actionFor('reservation.checked_in'), 'CHECK_IN');
  assert.equal(router.actionFor('reservation.checked_out'), 'CHECK_OUT');
  assert.equal(router.actionFor('reservation.unknown'), null);
  assert.equal(router.actionFor('invoice.finalized'), null);
});

test('route output shape is { channel, action, payload } and is pure', () => {
  const canonical = { event: 'reservation.created', reservation_id: 'r1', source: 'pms' };
  const out = router.route(canonical);
  assert.deepEqual(out, { channel: 'channel-manager', action: 'CREATE_BOOKING', payload: canonical });
  // purity: same input -> deeply equal output, source object untouched
  assert.deepEqual(router.route(canonical), out);
  assert.deepEqual(canonical, { event: 'reservation.created', reservation_id: 'r1', source: 'pms' });
  assert.equal(router.route({ event: 'nope' }), null);
  assert.equal(router.route(null), null);
});

test('normalize builds canonical shape without mutating the source event', () => {
  const event = Object.freeze({
    event_type: 'reservation.created',
    aggregate_id: 'res-9',
    property_id: 'prop-1',
    occurred_at: '2026-06-23T10:00:00.000Z',
    payload: Object.freeze({ reservation_id: 'res-9', guest_id: 'g-7', status: 'CONFIRMED' })
  });
  const c = normalize(event);
  assert.deepEqual(c, {
    event: 'reservation.created',
    reservation_id: 'res-9',
    property_id: 'prop-1',
    guest_id: 'g-7',
    status: 'CONFIRMED',
    timestamp: '2026-06-23T10:00:00.000Z',
    source: 'pms'
  });
});

test('subscriber registers exactly the 5 lifecycle events and captures them (no throw)', async () => {
  const bus = fakeBus();
  const unsub = buildChannelSubscriber({ eventBus: bus });
  try {
    for (const t of SUBSCRIBED_EVENTS) assert.equal(bus.count(t), 1, 'one listener for ' + t);
    // Emitting an event must not throw (handler is isolated; only logs).
    await bus.emit({ event_type: 'reservation.created', aggregate_id: 'r2', property_id: 'p1',
      occurred_at: '2026-06-23T11:00:00.000Z', payload: { reservation_id: 'r2', status: 'CONFIRMED' } });
  } finally { unsub(); }
  // after unsubscribe, listeners are gone
  for (const t of SUBSCRIBED_EVENTS) assert.equal(bus.count(t), 0);
});

test('idempotent init: second build does not stack duplicate listeners', () => {
  const bus = fakeBus();
  const unsub1 = buildChannelSubscriber({ eventBus: bus });
  const unsub2 = buildChannelSubscriber({ eventBus: bus }); // guard returns existing
  try {
    for (const t of SUBSCRIBED_EVENTS) assert.equal(bus.count(t), 1, 'still one listener for ' + t);
    assert.equal(unsub1, unsub2, 'same unsubscribe handle returned');
  } finally { unsub1(); }
});
