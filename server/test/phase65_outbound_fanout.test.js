'use strict';

/**
 * Phase 65 C1 + C3 — one PMS event must reach EVERY enabled mapped channel.
 *
 * THE DEFECT: channelEventRouter stamped every job with the literal
 * `channel: 'channel-manager'`. That is not an OTA code — realProcessor rejects
 * it as `no_provider_for_channel` — so nothing could ever be delivered. There
 * was no fan-out at all: one event produced exactly one job, aimed at nothing.
 *
 * Compounding it, the in-memory queue deduped on `reservation_id::action`, so
 * even after fan-out seven of eight channels would have been silently discarded.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/channel-manager/services/channelEventRouter');
const { fanOutAndEnqueue, normalize } = require('../src/channel-manager/services/channelSubscriber');
const { buildChannelSyncQueue } = require('../src/channel-manager/services/channelSyncQueue');

const ALL_EIGHT = [
  'BOOKING_COM', 'AGODA', 'EXPEDIA', 'AIRBNB',
  'MAKEMYTRIP', 'GOOGLE', 'TRIPADVISOR', 'QYRVIA_CONNECT'
];

const EVENT = Object.freeze({
  event_id: 'ev-1', event_type: 'reservation.created',
  aggregate_type: 'reservation', aggregate_id: 'res-1',
  tenant_id: 'tenant-1', property_id: 'prop-1',
  actor_id: 'user-1', request_id: 'rq-1',
  occurred_at: '2026-07-01T09:00:00.000Z',
  payload: Object.freeze({ reservation_id: 'res-1', status: 'CONFIRMED' })
});

// ---------------------------------------------------------------------------

test('C1: the router can no longer emit the "channel-manager" literal', async () => {
  // Behavioural, not textual: the module doc still discusses the old literal.
  assert.equal(router.ROUTE_TARGET, undefined, 'the bogus route target must not exist');

  // It cannot be routed to…
  assert.throws(() => router.route({ event: 'reservation.created' }, 'channel-manager'),
    (e) => e.code === 'channel_identity_invalid');
  assert.throws(() => router.routeAll({ event: 'reservation.created' }, ['channel-manager']),
    (e) => e.code === 'channel_identity_invalid');

  // …and it can never come out of a fan-out.
  const q = buildChannelSyncQueue();
  const out = await fanOutAndEnqueue(q, normalize(EVENT), async () => ALL_EIGHT);
  assert.ok(!out.channels.includes('channel-manager'));
  assert.ok(!q.list().some((i) => i.channel === 'channel-manager'));
});

test('C1: all eight canonical channels are routable, and QTCN is NOT', () => {
  assert.deepEqual([...router.ROUTABLE_CHANNELS].sort(), [...ALL_EIGHT].sort());
  assert.ok(!router.ROUTABLE_CHANNELS.includes('QTCN'),
    'QTCN is a read-only legacy alias — nothing new may be written with it');
});

test('C1: one event fans out to every enabled channel, exactly one job each', async () => {
  const q = buildChannelSyncQueue();
  const out = await fanOutAndEnqueue(q, normalize(EVENT), async () => ALL_EIGHT);

  assert.equal(out.ok, true);
  assert.deepEqual(out.channels, ALL_EIGHT);
  assert.equal(q.size(), 8, 'C3: the dedupe key includes the channel, so none collapse');

  const items = q.list();
  assert.deepEqual(items.map((i) => i.channel).sort(), [...ALL_EIGHT].sort());
  assert.ok(items.every((i) => i.action === 'CREATE_BOOKING'));
  assert.ok(items.every((i) => i.tenant_id === 'tenant-1' && i.property_id === 'prop-1'));
  assert.ok(items.every((i) => i.status === 'PENDING'));
});

test('C1: a DISABLED channel receives no job', async () => {
  const q = buildChannelSyncQueue();
  const out = await fanOutAndEnqueue(q, normalize(EVENT), async () => ([
    { channel: 'BOOKING_COM', enabled: true },
    { channel: 'AGODA',       enabled: false },
    { channel: 'EXPEDIA',     enabled: true }
  ]));
  assert.deepEqual(out.channels, ['BOOKING_COM', 'EXPEDIA']);
  assert.equal(q.size(), 2);
  assert.ok(!q.list().some((i) => i.channel === 'AGODA'));
});

test('C1: each lifecycle event maps to its action across the whole fan-out', async () => {
  const cases = [
    ['reservation.created',     'CREATE_BOOKING'],
    ['reservation.updated',     'UPDATE_BOOKING'],
    ['reservation.cancelled',   'CANCEL_BOOKING'],
    ['reservation.checked_in',  'CHECK_IN'],
    ['reservation.checked_out', 'CHECK_OUT']
  ];
  for (const [eventType, action] of cases) {
    const q = buildChannelSyncQueue();
    const ev = Object.assign({}, EVENT, { event_type: eventType });
    const out = await fanOutAndEnqueue(q, normalize(ev), async () => ['BOOKING_COM', 'AGODA']);
    assert.equal(out.ok, true, eventType);
    assert.equal(q.size(), 2, eventType + ' must reach both channels');
    assert.ok(q.list().every((i) => i.action === action), eventType + ' -> ' + action);
  }
});

test('C1: an unmapped event type produces no jobs at all', async () => {
  const q = buildChannelSyncQueue();
  const ev = Object.assign({}, EVENT, { event_type: 'invoice.finalized' });
  const out = await fanOutAndEnqueue(q, normalize(ev), async () => ALL_EIGHT);
  assert.equal(out.ok, true);
  assert.deepEqual(out.channels, []);
  assert.equal(q.size(), 0);
});

test('C3: the same reservation on two channels does NOT dedupe against itself', async () => {
  const q = buildChannelSyncQueue();
  await fanOutAndEnqueue(q, normalize(EVENT), async () => ['BOOKING_COM', 'AGODA']);
  assert.equal(q.size(), 2);

  // Re-emitting the SAME event while both jobs are still PENDING must dedupe.
  await fanOutAndEnqueue(q, normalize(EVENT), async () => ['BOOKING_COM', 'AGODA']);
  assert.equal(q.size(), 2, 'a true duplicate is still deduped per channel');
});

test('C3: two tenants with the same reservation id never collide', async () => {
  const q = buildChannelSyncQueue();
  await fanOutAndEnqueue(q, normalize(EVENT), async () => ['AGODA']);
  const other = Object.assign({}, EVENT, { tenant_id: 'tenant-2' });
  await fanOutAndEnqueue(q, normalize(other), async () => ['AGODA']);
  assert.equal(q.size(), 2, 'the dedupe key is tenant-scoped');
});

test('C1: a legacy QTCN mapping row produces a QYRVIA_CONNECT job', async () => {
  const q = buildChannelSyncQueue();
  const out = await fanOutAndEnqueue(q, normalize(EVENT), async () => ['QTCN']);
  assert.deepEqual(out.channels, ['QYRVIA_CONNECT']);
  assert.equal(q.list()[0].channel, 'QYRVIA_CONNECT',
    'historical rows are readable, but all NEW state is canonical');
});
