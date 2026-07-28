'use strict';

/**
 * Phase 66A C5 — the production enabled-channel resolver.
 *
 * Phase 65 built per-OTA fan-out but wired nothing to fan out TO, so the spine
 * correctly refused to guess and enqueued nothing. This file covers the missing
 * half: resolving the ENABLED channels for a property, tenant-bound, fail-closed.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEnabledChannelResolver, RESOLVER_SQL
} = require('../src/channel-manager/services/enabledChannelResolver');
const { fanOutAndEnqueue, normalize } = require('../src/channel-manager/services/channelSubscriber');
const { buildChannelSyncQueue } = require('../src/channel-manager/services/channelSyncQueue');

const TENANT = '11111111-1111-1111-1111-111111111111';
const PROP   = '22222222-2222-2222-2222-222222222222';

/** A read-only unit of work that records how it was called. */
function fakeUow(rows, opts = {}) {
  const calls = { tenants: [], sql: [], params: [] };
  const runWithTenantRead = async (pool, tenantId, cb) => {
    calls.tenants.push(tenantId);
    if (opts.throwOnRead) throw new Error('registry unreachable');
    return cb({
      async query(sql, params) {
        calls.sql.push(sql);
        calls.params.push(params);
        return { rows };
      }
    }, { tenantId, mode: 'read' });
  };
  return { calls, pool: { connect: async () => ({}) }, runWithTenantRead };
}

const row = (code, enabled = true) => ({ channel_code: code, enabled, status: 'live' });

const EVENT = Object.freeze({
  event_id: 'ev-1', event_type: 'reservation.created',
  aggregate_type: 'reservation', aggregate_id: 'res-1',
  tenant_id: TENANT, property_id: PROP, actor_id: 'u1', request_id: 'rq1',
  occurred_at: '2026-07-27T09:00:00.000Z',
  payload: Object.freeze({ reservation_id: 'res-1', status: 'CONFIRMED' })
});

// ---------------------------------------------------------------------------
// The resolver itself
// ---------------------------------------------------------------------------

test('C5: the resolver reads inside a TENANT-BOUND read unit, scoped to the event tenant', async () => {
  const uow = fakeUow([row('BOOKING_COM'), row('AGODA')]);
  const resolve = buildEnabledChannelResolver(uow);

  const out = await resolve({ tenantId: TENANT, propertyId: PROP });

  assert.deepEqual(out, ['BOOKING_COM', 'AGODA']);
  assert.deepEqual(uow.calls.tenants, [TENANT], 'bound to the trusted tenant');
  assert.deepEqual(uow.calls.params[0], [TENANT, PROP]);
});

test('C5: the SQL asks the database for ENABLED rows only — it does not filter in JS alone', () => {
  assert.match(RESOLVER_SQL, /enabled\s*=\s*true/);
  assert.match(RESOLVER_SQL, /tenant_id\s*=\s*\$1/);
  assert.match(RESOLVER_SQL, /FROM channel_registry/);
  assert.ok(!/INSERT|UPDATE|DELETE/i.test(RESOLVER_SQL), 'resolving must never mutate');
});

test('C5: a disabled row is never returned, even if the query returned it', async () => {
  const uow = fakeUow([row('BOOKING_COM', true), row('AGODA', false), row('EXPEDIA', true)]);
  const out = await buildEnabledChannelResolver(uow)({ tenantId: TENANT, propertyId: PROP });
  assert.deepEqual(out, ['BOOKING_COM', 'EXPEDIA']);
});

test('C5: an empty registry means NO channels — never "every channel we know"', async () => {
  const uow = fakeUow([]);
  const out = await buildEnabledChannelResolver(uow)({ tenantId: TENANT, propertyId: PROP });
  assert.deepEqual(out, [], 'no mapping must not silently become a broadcast');
});

test('C5: a registry read failure THROWS (fail closed)', async () => {
  const uow = fakeUow([], { throwOnRead: true });
  await assert.rejects(
    () => buildEnabledChannelResolver(uow)({ tenantId: TENANT, propertyId: PROP }),
    /registry unreachable/);
});

test('C5: a missing tenant is refused as channel_registry_unavailable', async () => {
  const uow = fakeUow([row('AGODA')]);
  await assert.rejects(
    () => buildEnabledChannelResolver(uow)({ tenantId: null, propertyId: PROP }),
    (e) => e.code === 'channel_registry_unavailable');
  assert.deepEqual(uow.calls.tenants, [], 'no read may be attempted without a tenant');
});

test('C5: a historical QTCN row resolves to canonical QYRVIA_CONNECT', async () => {
  const uow = fakeUow([row('QTCN'), row('BOOKING_COM')]);
  const out = await buildEnabledChannelResolver(uow)({ tenantId: TENANT, propertyId: PROP });
  assert.deepEqual(out, ['QYRVIA_CONNECT', 'BOOKING_COM']);
  assert.ok(!out.includes('QTCN'), 'a legacy code must never leave the read path');
});

test('C5: a non-canonical registry code is refused, not silently skipped', async () => {
  const uow = fakeUow([row('SOME_OLD_JUNK')]);
  await assert.rejects(
    () => buildEnabledChannelResolver(uow)({ tenantId: TENANT, propertyId: PROP }),
    (e) => e.code === 'channel_identity_invalid');
});

test('C5: duplicate registry rows for one channel yield one code', async () => {
  const uow = fakeUow([row('AGODA'), row('AGODA'), row('QTCN'), row('QYRVIA_CONNECT')]);
  const out = await buildEnabledChannelResolver(uow)({ tenantId: TENANT, propertyId: PROP });
  assert.deepEqual(out, ['AGODA', 'QYRVIA_CONNECT']);
});

test('C5: the resolver requires its dependencies rather than degrading', () => {
  assert.throws(() => buildEnabledChannelResolver({ pool: null, runWithTenantRead: () => {} }), /pool/);
  assert.throws(() => buildEnabledChannelResolver({ pool: {} }), /runWithTenantRead/);
});

// ---------------------------------------------------------------------------
// The resolver joined to the spine — the behaviour the phase actually wants
// ---------------------------------------------------------------------------

test('C5 end to end: one event fans out to exactly the ENABLED mappings', async () => {
  const uow = fakeUow([row('BOOKING_COM'), row('AGODA', false), row('QYRVIA_CONNECT')]);
  const resolve = buildEnabledChannelResolver(uow);
  const q = buildChannelSyncQueue();

  const fan = await fanOutAndEnqueue(q, normalize(EVENT), resolve);

  assert.equal(fan.ok, true);
  assert.deepEqual(fan.channels, ['BOOKING_COM', 'QYRVIA_CONNECT']);
  assert.equal(q.size(), 2, 'the disabled channel gets no job');
  assert.ok(!q.list().some((j) => j.channel === 'AGODA'));
});

test('C5 end to end: every job carries the TRUSTED tenant and property', async () => {
  const uow = fakeUow([row('BOOKING_COM'), row('EXPEDIA')]);
  const q = buildChannelSyncQueue();
  await fanOutAndEnqueue(q, normalize(EVENT), buildEnabledChannelResolver(uow));

  for (const job of q.list()) {
    assert.equal(job.tenant_id, TENANT);
    assert.equal(job.property_id, PROP);
    assert.equal(job.event_id, 'ev-1');
    assert.equal(job.action, 'CREATE_BOOKING');
  }
});

test('C5 end to end: a registry failure produces ZERO jobs and a visible reason', async () => {
  const uow = fakeUow([], { throwOnRead: true });
  const q = buildChannelSyncQueue();

  const fan = await fanOutAndEnqueue(q, normalize(EVENT), buildEnabledChannelResolver(uow));

  assert.equal(fan.ok, false);
  assert.equal(fan.reason, 'channel_registry_unavailable');
  assert.match(fan.detail, /registry unreachable/);
  assert.equal(q.size(), 0, 'an unreadable registry is not permission to broadcast');
});

test('C5 end to end: a property with no enabled channel produces zero jobs and no error', async () => {
  const uow = fakeUow([row('BOOKING_COM', false)]);
  const q = buildChannelSyncQueue();
  const fan = await fanOutAndEnqueue(q, normalize(EVENT), buildEnabledChannelResolver(uow));
  assert.equal(fan.ok, true, 'selling nowhere is a legitimate state, not a failure');
  assert.deepEqual(fan.channels, []);
  assert.equal(q.size(), 0);
});

test('C5: production boot wires the resolver into the spine', () => {
  // Guards the wiring itself: the resolver must be constructed and passed at
  // boot, not merely exist. Phase 65 shipped the capability with no caller.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /buildEnabledChannelResolver\(/, 'boot must construct the resolver');
  assert.match(src, /buildChannelSubscriber\(\{[\s\S]{0,400}resolveChannels/,
    'boot must pass resolveChannels into the subscriber');
  assert.match(src, /runWithTenantRead:\s*_uow\.runWithTenantRead/,
    'the resolver must be given the tenant-bound read unit, not a bare pool');
});
