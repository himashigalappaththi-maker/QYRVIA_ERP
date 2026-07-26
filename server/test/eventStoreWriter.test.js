'use strict';

/**
 * Phase 63 P0-1 — unit coverage for the monotonic event_store writer.
 * Runs without a database (fake queryable), so it is part of the plain
 * `npm test` non-DB baseline. The real-PostgreSQL proof lives in
 * test/db/event_store_versioning.db.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDomainEventWriter, INSERT_SQL } = require('../src/core/eventStoreWriter');

function ev(over = {}) {
  return Object.assign({
    event_id:       '11111111-1111-1111-1111-111111111111',
    event_type:     'reservation.created',
    aggregate_type: 'reservation',
    aggregate_id:   'RES-1',
    tenant_id:      '22222222-2222-2222-2222-222222222222',
    property_id:    '33333333-3333-3333-3333-333333333333',
    actor_id:       null,
    request_id:     'req-1',
    payload:        { a: 1 },
    occurred_at:    '2026-07-26T00:00:00.000Z'
  }, over);
}

test('writer requires a queryable', () => {
  assert.throws(() => buildDomainEventWriter(null), /queryable/);
  assert.throws(() => buildDomainEventWriter({}), /queryable/);
});

test('writer never sends a hard-coded event_version; the SQL computes MAX+1', () => {
  assert.match(INSERT_SQL, /MAX\(es\.event_version\)/);
  assert.match(INSERT_SQL, /\)\s*,\s*0\)\s*\+\s*1/);
  assert.match(INSERT_SQL, /ON CONFLICT \(tenant_id, aggregate_type, aggregate_id, event_version\) DO NOTHING/);
});

test('a successful insert returns the persisted version and passes 10 params', async () => {
  let seen = null;
  const q = { async query(sql, params) { seen = { sql, params }; return { rows: [{ event_version: 7 }] }; } };
  const v = await buildDomainEventWriter(q)(ev());
  assert.equal(v, 7);
  assert.equal(seen.params.length, 10, 'exactly 10 bound parameters');
  assert.equal(seen.params[0], '11111111-1111-1111-1111-111111111111');
  assert.equal(seen.params[3], 'reservation');
  assert.equal(seen.params[4], 'RES-1');
  assert.equal(seen.params[6], JSON.stringify({ a: 1 }), 'payload is serialised to jsonb text');
  assert.ok(!seen.params.includes(1), 'no literal version 1 is bound');
});

test('a zero-row result (version race) is retried until it wins', async () => {
  let calls = 0;
  const q = {
    async query() {
      calls += 1;
      return calls < 3 ? { rows: [] } : { rows: [{ event_version: 3 }] };
    }
  };
  const v = await buildDomainEventWriter(q)(ev());
  assert.equal(v, 3);
  assert.equal(calls, 3, 'retried twice before succeeding');
});

test('persistent contention throws instead of silently dropping the event', async () => {
  let calls = 0;
  const q = { async query() { calls += 1; return { rows: [] }; } };
  await assert.rejects(
    () => buildDomainEventWriter(q, { maxAttempts: 4 })(ev()),
    /event_store_version_contention/
  );
  assert.equal(calls, 4, 'bounded retry — no infinite loop');
});

test('a non-version database error propagates immediately (no retry, no swallow)', async () => {
  let calls = 0;
  const q = {
    async query() {
      calls += 1;
      const e = new Error('duplicate key value violates unique constraint "event_store_pkey"');
      e.code = '23505'; e.constraint = 'event_store_pkey';
      throw e;
    }
  };
  await assert.rejects(() => buildDomainEventWriter(q)(ev()), /event_store_pkey/);
  assert.equal(calls, 1, 'a replayed event_id must surface on the first attempt');
});

test('missing event_id is rejected before touching the database', async () => {
  let called = false;
  const q = { async query() { called = true; return { rows: [] }; } };
  await assert.rejects(() => buildDomainEventWriter(q)(ev({ event_id: null })), /event_id/);
  assert.equal(called, false);
});

test('null/undefined payload is normalised to an empty object', async () => {
  let seen = null;
  const q = { async query(sql, params) { seen = params; return { rows: [{ event_version: 1 }] }; } };
  const w = buildDomainEventWriter(q);
  await w(ev({ payload: null }));
  assert.equal(seen[6], '{}');
  await w(ev({ payload: undefined }));
  assert.equal(seen[6], '{}');
});
