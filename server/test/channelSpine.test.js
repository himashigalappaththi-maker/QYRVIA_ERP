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

// ---------------------------------------------------------------------------
// PHASE 65 C1 — DELIBERATE TEST INVERSION
//
//   OLD DEFECTIVE CONTRACT: route(canonical) returned a single job stamped
//     { channel: 'channel-manager' } — the literal ROUTE_TARGET. This test
//     asserted that literal, and so locked in the defect: 'channel-manager' is
//     not an OTA code, no provider resolves it, and realProcessor rejects it as
//     no_provider_for_channel. The outbound spine could never deliver anything.
//
//   NEW CORRECT CONTRACT: route(canonical, channel) routes to ONE named
//     canonical channel and THROWS channel_identity_invalid on an unrecognised
//     code; routeAll(canonical, channels) fans out to every mapped channel.
//
//   JUSTIFYING PRODUCTION CHANGE: ROUTE_TARGET deleted from
//     src/channel-manager/services/channelEventRouter.js; route() now takes a
//     channel argument and routeAll() added.
// ---------------------------------------------------------------------------
test('route targets ONE canonical channel and is pure', () => {
  const canonical = { event: 'reservation.created', reservation_id: 'r1', source: 'pms' };
  const out = router.route(canonical, 'BOOKING_COM');
  assert.deepEqual(out, { channel: 'BOOKING_COM', action: 'CREATE_BOOKING', payload: canonical });
  // purity: same input -> deeply equal output, source object untouched
  assert.deepEqual(router.route(canonical, 'BOOKING_COM'), out);
  assert.deepEqual(canonical, { event: 'reservation.created', reservation_id: 'r1', source: 'pms' });
  assert.equal(router.route({ event: 'nope' }, 'BOOKING_COM'), null);
  assert.equal(router.route(null, 'BOOKING_COM'), null);
});

test('route FAILS CLOSED on a non-canonical channel code', () => {
  const canonical = { event: 'reservation.created', reservation_id: 'r1', source: 'pms' };
  // The old literal is now exactly what must be refused.
  assert.throws(() => router.route(canonical, 'channel-manager'),
    (e) => e.code === 'channel_identity_invalid');
  assert.throws(() => router.route(canonical, undefined),
    (e) => e.code === 'channel_identity_invalid');
});

test('routeAll fans one event out to every mapped channel, once each', () => {
  const canonical = { event: 'reservation.created', reservation_id: 'r1', source: 'pms' };
  const jobs = router.routeAll(canonical, ['BOOKING_COM', 'AGODA', 'QYRVIA_CONNECT']);
  assert.deepEqual(jobs.map((j) => j.channel), ['BOOKING_COM', 'AGODA', 'QYRVIA_CONNECT']);
  assert.ok(jobs.every((j) => j.action === 'CREATE_BOOKING'));

  // a repeated channel yields ONE job, not two
  assert.equal(router.routeAll(canonical, ['AGODA', 'AGODA']).length, 1);
  // an explicitly disabled mapping row is skipped
  assert.deepEqual(
    router.routeAll(canonical, [{ channel: 'AGODA', enabled: false }, { channel: 'EXPEDIA' }])
      .map((j) => j.channel), ['EXPEDIA']);
  // no mapping is a legitimate state, not an error
  assert.deepEqual(router.routeAll(canonical, []), []);
  // an unknown event type maps to no action
  assert.deepEqual(router.routeAll({ event: 'invoice.finalized' }, ['AGODA']), []);
});

test('routeAll canonicalises the legacy QTCN/qytn codes but never emits them', () => {
  const canonical = { event: 'reservation.created', reservation_id: 'r1', source: 'pms' };
  for (const legacy of ['QTCN', 'qytn']) {
    const jobs = router.routeAll(canonical, [legacy]);
    assert.deepEqual(jobs.map((j) => j.channel), ['QYRVIA_CONNECT'],
      legacy + ' must be READ as QYRVIA_CONNECT and never written back');
  }
  assert.throws(() => router.routeAll(canonical, ['NOT_A_CHANNEL']),
    (e) => e.code === 'channel_identity_invalid');
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
  // ---------------------------------------------------------------------
  // PHASE 65 C2 — DELIBERATE TEST INVERSION
  //
  //   OLD DEFECTIVE CONTRACT: this deepEqual pinned the canonical shape to
  //     SEVEN fields, and thereby asserted that tenant_id, actor_id,
  //     request_id, event_id, aggregate_type and aggregate_id are DROPPED —
  //     even though the source domain event carries all of them. Downstream,
  //     realProcessor rejects a tenant-less job as tenant_required and the
  //     dead-letter store recorded the literal string 'unknown'.
  //
  //   NEW CORRECT CONTRACT: trusted identity is preserved and travels with the
  //     job. tenant_id/property_id come from the event ENVELOPE only, never
  //     from event.payload (which is attacker-influenced command input).
  //
  //   JUSTIFYING PRODUCTION CHANGE: normalize() in
  //     src/channel-manager/services/channelSubscriber.js.
  // ---------------------------------------------------------------------
  assert.deepEqual(c, {
    tenant_id: null,          // absent on this fixture event — see the next test
    property_id: 'prop-1',
    actor_id: null,
    request_id: null,
    event_id: null,
    event_type: 'reservation.created',
    aggregate_type: null,
    aggregate_id: 'res-9',
    occurred_at: '2026-06-23T10:00:00.000Z',
    event: 'reservation.created',
    reservation_id: 'res-9',
    guest_id: 'g-7',
    status: 'CONFIRMED',
    timestamp: '2026-06-23T10:00:00.000Z',
    source: 'pms'
  });
});

test('C2: normalize takes tenant/property from the trusted envelope, NEVER from the payload', () => {
  const event = Object.freeze({
    event_type: 'reservation.created',
    event_id: 'ev-1',
    aggregate_type: 'reservation',
    aggregate_id: 'res-9',
    tenant_id: 'tenant-real',
    property_id: 'prop-real',
    actor_id: 'user-1',
    request_id: 'rq-1',
    occurred_at: '2026-06-23T10:00:00.000Z',
    // A hostile payload trying to steer the job at another tenant/property.
    payload: Object.freeze({
      reservation_id: 'res-9',
      tenant_id: 'tenant-ATTACKER',
      property_id: 'prop-ATTACKER'
    })
  });
  const c = normalize(event);
  assert.equal(c.tenant_id, 'tenant-real');
  assert.equal(c.property_id, 'prop-real');
  assert.equal(c.actor_id, 'user-1');
  assert.equal(c.request_id, 'rq-1');
  assert.equal(c.event_id, 'ev-1');
  assert.equal(c.aggregate_type, 'reservation');
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
