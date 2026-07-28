'use strict';

/**
 * Phase 65 C2 — trusted identity must reach every outbound job.
 *
 * THE DEFECT: channelSubscriber.normalize() dropped tenant_id, actor_id,
 * request_id, event_id, aggregate_type and aggregate_id, and enqueueRouted()
 * forwarded neither tenant_id nor property_id. Downstream, realProcessor
 * rejects a tenant-less job as `tenant_required`, the dead-letter store wrote
 * the literal string 'unknown' into tenant_id, and against the DB-backed queue
 * the enqueue THROWS because the column is NOT NULL REFERENCES tenants(id).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalize, enqueueRouted, fanOutAndEnqueue
} = require('../src/channel-manager/services/channelSubscriber');
const { buildChannelSyncQueue } = require('../src/channel-manager/services/channelSyncQueue');

const FULL_EVENT = Object.freeze({
  event_id:       'ev-1',
  event_type:     'reservation.created',
  aggregate_type: 'reservation',
  aggregate_id:   'res-1',
  tenant_id:      'tenant-1',
  property_id:    'prop-1',
  actor_id:       'user-1',
  request_id:     'rq-1',
  occurred_at:    '2026-07-01T09:00:00.000Z',
  payload:        Object.freeze({ reservation_id: 'res-1', status: 'CONFIRMED' })
});

const routed = (channel) => ({ channel, action: 'CREATE_BOOKING', payload: {} });

// ---------------------------------------------------------------------------

test('C2: every mandated identity field survives normalization', () => {
  const c = normalize(FULL_EVENT);
  for (const [field, expected] of Object.entries({
    tenant_id: 'tenant-1', property_id: 'prop-1', actor_id: 'user-1',
    request_id: 'rq-1', event_id: 'ev-1', event_type: 'reservation.created',
    aggregate_type: 'reservation', aggregate_id: 'res-1',
    occurred_at: '2026-07-01T09:00:00.000Z'
  })) {
    assert.equal(c[field], expected, field + ' must survive normalization');
  }
});

test('C2: normalization does not mutate the source event', () => {
  const before = JSON.stringify(FULL_EVENT);
  normalize(FULL_EVENT);
  assert.equal(JSON.stringify(FULL_EVENT), before);
});

test('C2: the enqueued job carries the identity, not just the reservation', () => {
  const q = buildChannelSyncQueue();
  const res = enqueueRouted(q, normalize(FULL_EVENT), routed('BOOKING_COM'));
  assert.equal(res.accepted, true);
  assert.equal(res.item.tenant_id, 'tenant-1');
  assert.equal(res.item.property_id, 'prop-1');
  assert.equal(res.item.actor_id, 'user-1');
  assert.equal(res.item.request_id, 'rq-1');
  assert.equal(res.item.event_id, 'ev-1');
  assert.equal(res.item.aggregate_type, 'reservation');
  assert.equal(res.item.channel, 'BOOKING_COM');
});

test('C2: a missing tenant FAILS CLOSED with tenant_required — never enqueued as "unknown"', () => {
  const q = buildChannelSyncQueue();
  const canonical = normalize(Object.assign({}, FULL_EVENT, { tenant_id: null }));
  const res = enqueueRouted(q, canonical, routed('BOOKING_COM'));

  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'tenant_required');
  assert.equal(q.size(), 0, 'nothing may reach the queue without a tenant');
  assert.notEqual(res.reason, 'unknown');
});

test('C2: a missing property FAILS CLOSED with property_required', () => {
  const q = buildChannelSyncQueue();
  const canonical = normalize(Object.assign({}, FULL_EVENT, { property_id: null }));
  const res = enqueueRouted(q, canonical, routed('BOOKING_COM'));
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'property_required');
  assert.equal(q.size(), 0);
});

test('C2: a job with no channel FAILS CLOSED with channel_identity_invalid', () => {
  const q = buildChannelSyncQueue();
  const res = enqueueRouted(q, normalize(FULL_EVENT), { action: 'CREATE_BOOKING', channel: null });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'channel_identity_invalid');
  assert.equal(q.size(), 0);
});

test('C2: tenant/property are taken from the envelope even when the payload disagrees', () => {
  const hostile = Object.assign({}, FULL_EVENT, {
    payload: { reservation_id: 'res-1', tenant_id: 'evil-tenant', property_id: 'evil-prop' }
  });
  const c = normalize(hostile);
  assert.equal(c.tenant_id, 'tenant-1');
  assert.equal(c.property_id, 'prop-1');

  const q = buildChannelSyncQueue();
  enqueueRouted(q, c, routed('AGODA'));
  assert.equal(q.list()[0].tenant_id, 'tenant-1',
    'command input must never be able to steer a job at another tenant');
});

// ---------------------------------------------------------------------------
// fan-out + registry failure, fail closed
// ---------------------------------------------------------------------------

test('C1: a registry that THROWS enqueues nothing (fail closed, not fail open)', async () => {
  const q = buildChannelSyncQueue();
  const out = await fanOutAndEnqueue(q, normalize(FULL_EVENT), async () => {
    throw new Error('registry down');
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'channel_registry_unavailable');
  assert.equal(q.size(), 0, 'a registry we cannot read is not permission to broadcast');
});

test('C1: NO resolver wired enqueues nothing and reports why', async () => {
  const q = buildChannelSyncQueue();
  const out = await fanOutAndEnqueue(q, normalize(FULL_EVENT), undefined);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'channel_registry_unavailable');
  assert.equal(q.size(), 0,
    'the old behaviour enqueued one job stamped "channel-manager"; a bogus job is worse than none');
});

test('C1: a non-array registry answer is treated as unavailable', async () => {
  const q = buildChannelSyncQueue();
  for (const bad of [null, undefined, 'BOOKING_COM', 42, {}]) {
    const out = await fanOutAndEnqueue(q, normalize(FULL_EVENT), async () => bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.equal(out.reason, 'channel_registry_unavailable');
  }
  assert.equal(q.size(), 0);
});

test('C1: an unknown channel code refuses the whole fan-out', async () => {
  const q = buildChannelSyncQueue();
  const out = await fanOutAndEnqueue(q, normalize(FULL_EVENT),
    async () => ['BOOKING_COM', 'NOT_A_REAL_OTA']);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'channel_identity_invalid');
  assert.equal(q.size(), 0, 'partial fan-out on a bad mapping would be worse than none');
});

test('C1: an empty mapping set is a legitimate state, not an error', async () => {
  const q = buildChannelSyncQueue();
  const out = await fanOutAndEnqueue(q, normalize(FULL_EVENT), async () => []);
  assert.equal(out.ok, true);
  assert.deepEqual(out.channels, []);
  assert.equal(q.size(), 0);
});
