'use strict';

/**
 * Phase 66A-B2N-C2 — focused BEHAVIOURAL contract for collision-safe
 * restriction-rule outbox events (key version aob:v2).
 *
 * Fake pools and fake transaction clients only — no PostgreSQL connection,
 * no network, no migration.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAriDedupeKey, buildAriRestrictionDedupeKey
} = require('../src/ari/outbox/ariOutboxStore');
const { withTenantAriUnit } = require('../src/ari/store/tenantAriStore');
const { runWithTenantTransaction, ERR } = require('../src/db/tenantUnitOfWork');
const { buildAriHandlers } = require('../src/ari/api/ari.handlers');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PROPERTY = '33333333-3333-4333-8333-333333333333';

const BASE = {
  restrictionRuleId: 'rr-1', level: 'property',
  roomTypeId: null, ratePlanId: null, channel: null,
  effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', sourceVersion: 1
};
const k = (over) => buildAriRestrictionDedupeKey(Object.assign({}, BASE, over));

// ---------------------------------------------------------------------------
// 1-6. All four scopes, distinctness, and per-rule identity
// ---------------------------------------------------------------------------

test('1-4. all four restriction scopes produce a valid aob:v2 key', () => {
  const scopes = [
    { roomTypeId: null,  ratePlanId: null },   // property-wide
    { roomTypeId: 'rt1', ratePlanId: null },   // room-type only
    { roomTypeId: null,  ratePlanId: 'rp1' },  // rate-plan only
    { roomTypeId: 'rt1', ratePlanId: 'rp1' }   // combined
  ];
  for (const s of scopes) assert.match(k(s), /^aob:v2:[0-9a-f]{64}$/);
});

test('5. all four scopes generate DISTINCT keys', () => {
  const keys = [
    k({ roomTypeId: null,  ratePlanId: null }),
    k({ roomTypeId: 'rt1', ratePlanId: null }),
    k({ roomTypeId: null,  ratePlanId: 'rp1' }),
    k({ roomTypeId: 'rt1', ratePlanId: 'rp1' })
  ];
  assert.equal(new Set(keys).size, 4);
});

test('6. two different rule ids with identical scope, period and version are DISTINCT', () => {
  assert.notEqual(k({ restrictionRuleId: 'rr-1' }), k({ restrictionRuleId: 'rr-2' }));
});

test('level and channel are genuine identity dimensions', () => {
  assert.notEqual(k({ level: 'property' }), k({ level: 'channel' }));
  assert.notEqual(k({ channel: null }), k({ channel: 'BOOKING_COM' }));
});

test('a null scope value is distinct from any string, including look-alikes', () => {
  assert.notEqual(k({ roomTypeId: null }), k({ roomTypeId: 'null' }));
  assert.notEqual(k({ ratePlanId: null }), k({ ratePlanId: '-' }));
});

test('identifiers containing delimiters cannot collide through boundary ambiguity', () => {
  assert.notEqual(
    k({ restrictionRuleId: 'a|b', level: 'property', roomTypeId: 'c' }),
    k({ restrictionRuleId: 'a', level: 'property', roomTypeId: 'b|c' })
  );
});

// ---------------------------------------------------------------------------
// v1 is untouched; the two key versions are disjoint
// ---------------------------------------------------------------------------

test('18. v1 events still produce aob:v1 keys with the unchanged 7-element tuple', () => {
  const v1 = buildAriDedupeKey({
    eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY', roomTypeId: 'rt1',
    ratePlanId: null, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-02', sourceVersion: 1
  });
  assert.match(v1, /^aob:v1:[0-9a-f]{64}$/);
});

test('19/20. a v2 restriction key is never a v1 key, and the prefixes cannot collide', () => {
  const v2 = k({});
  const v1 = buildAriDedupeKey({
    eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY', roomTypeId: 'rt1',
    ratePlanId: null, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', sourceVersion: 1
  });
  assert.ok(v2.startsWith('aob:v2:'));
  assert.ok(v1.startsWith('aob:v1:'));
  assert.notEqual(v2, v1);
});

// ---------------------------------------------------------------------------
// Fake pool
// ---------------------------------------------------------------------------

function makeFakePool({ boundTenantId, failOn, persisted } = {}) {
  const state = { connects: 0, begins: 0, commits: 0, rollbacks: 0, statements: [] };
  let seq = 0;
  function makeClient() {
    const clientId = ++seq;
    return {
      async query(text, params) {
        const sql = String(text).trim();
        if (/^BEGIN/i.test(sql)) { state.begins += 1; return { rows: [] }; }
        if (/^COMMIT/i.test(sql)) { state.commits += 1; return { rows: [] }; }
        if (/^ROLLBACK/i.test(sql)) { state.rollbacks += 1; return { rows: [] }; }
        if (/set_config\('app\.tenant_id'/.test(sql)) return { rows: [] };
        if (/app_current_tenant\(\)/.test(sql)) return { rows: [{ tid: boundTenantId }] };

        const kind = /INSERT INTO ari_outbox_store/i.test(sql) ? 'outbox'
          : /SELECT \* FROM ari_outbox_store/i.test(sql) ? 'outbox_lookup'
            : /ari_restriction_rule/i.test(sql) ? 'restriction' : 'ari';
        state.statements.push({ kind, clientId, sql, params });
        if (failOn && failOn(kind, state.statements.filter((s) => s.kind === kind).length)) {
          throw new Error('simulated_' + kind + '_failure');
        }
        if (kind === 'restriction') {
          return { rows: [Object.assign({
            id: 'rr-1', property_id: PROPERTY, level: 'property',
            room_type_id: null, rate_plan_id: null, channel: null,
            date_from: '2026-09-01', date_to: '2026-09-30', dow: null,
            cta: null, ctd: null, min_los: 2, max_los: null, stay_through: null,
            min_advance_days: null, max_advance_days: null, priority: 0,
            version: 1, updated_at: '2026-09-01T00:00:00.000Z'
          }, persisted || {})] };
        }
        return { rows: [{ version: 1, sold: 1 }] };
      },
      release() {}
    };
  }
  return { pool: { async connect() { state.connects += 1; return makeClient(); } }, state };
}
const outboxRows = (s) => s.statements.filter((x) => x.kind === 'outbox');

// ---------------------------------------------------------------------------
// SQL-level idempotency and persisted-row return (7, 8, 10)
// ---------------------------------------------------------------------------

test('7/8. the upsert compares only the five conflict-updated fields with IS DISTINCT FROM, and reads back on a no-op', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await withTenantAriUnit(pool, TENANT_A, ({ ariStore }) => ariStore.putRestrictionRule({
    tenant_id: TENANT_A, id: 'rr-1', propertyId: PROPERTY, level: 'property',
    date_from: '2026-09-01', date_to: '2026-09-30', minLos: 2
  }));
  const sql = state.statements.find((s) => s.kind === 'restriction').sql;
  // The no-op guard exists and covers exactly the updated fields.
  assert.match(sql, /IS DISTINCT FROM/);
  const guard = sql.slice(sql.indexOf('WHERE ('), sql.indexOf('RETURNING'));
  for (const f of ['cta', 'ctd', 'min_los', 'max_los', 'stay_through']) {
    assert.ok(guard.includes('ari_restriction_rule.' + f), 'guard covers ' + f);
    assert.ok(guard.includes('EXCLUDED.' + f), 'guard compares EXCLUDED.' + f);
  }
  for (const f of ['property_id', 'level', 'room_type_id', 'rate_plan_id', 'channel', 'date_from', 'date_to', 'dow', 'priority']) {
    assert.ok(!guard.includes('ari_restriction_rule.' + f), 'guard must not cover scope field ' + f);
  }
  // A skipped UPDATE still returns the persisted row, in ONE statement.
  assert.match(sql, /WITH upserted AS \(/);
  assert.match(sql, /UNION ALL/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM upserted\)/);
  assert.equal(state.statements.filter((s) => s.kind === 'restriction').length, 1, 'exactly one statement');
});

test('the version is never derived in JavaScript, from a timestamp, a hash or the request', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ari', 'store', 'dbStore.js'), 'utf8');
  const body = src.slice(src.indexOf('  async function putRestrictionRule('), src.indexOf('\n  /** Optimistic update'));
  assert.ok(!/Date\.now|new Date\(|createHash|\+\s*1\s*;/.test(body));
  assert.match(body, /version=ari_restriction_rule\.version\+1/, 'the database computes the increment');
});

test('3/10. identity and payload come from the PERSISTED row — a conflicting request scope is ignored', async () => {
  // The database returns property-wide scope; the REQUEST asks for a room type.
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const h = buildAriHandlers({ withAriUnit: (t, cb) => withTenantAriUnit(pool, t, cb) });
  const res = { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
  await h.upsertRestrictionRule({
    ctx: { tenantId: TENANT_A, propertyId: PROPERTY },
    body: { id: 'rr-1', level: 'channel', roomTypeId: 'rt-REQUEST-ONLY', date_from: '2026-01-01', date_to: '2026-01-31', minLos: 9 }
  }, res);
  assert.equal(res._status, 200);
  const ev = outboxRows(state)[0];
  assert.ok(ev, 'an event was enqueued');
  // INSERT params: 1 tenant, 2 property, 3 event_type, 4 resource_kind,
  // 5 room_type_id, 6 rate_plan_id, 7 effective_from, 8 effective_to,
  // 9 source_version, 10 dedupe_key, 11 payload, 12 restriction_rule_id
  assert.equal(ev.params[4], null, 'persisted (null) room type, NOT the request value');
  assert.equal(ev.params[6], '2026-09-01', 'persisted date_from, not the request');
  assert.equal(ev.params[7], '2026-09-30', 'persisted date_to, not the request');
  assert.equal(ev.params[11], 'rr-1');
  assert.equal(ev.params[9], buildAriRestrictionDedupeKey({
    restrictionRuleId: 'rr-1', level: 'property', roomTypeId: null, ratePlanId: null,
    channel: null, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', sourceVersion: 1
  }), 'the key is built from the persisted row');
  assert.equal(res._json.data.roomTypeId, null, 'the response reports persisted scope');
  assert.equal(res._json.data.level, 'property');
});

test('an identical retry preserves the version and therefore recomputes the SAME key', () => {
  const first  = k({ sourceVersion: 1 });
  const retry  = k({ sourceVersion: 1 });
  const bumped = k({ sourceVersion: 2 });
  assert.equal(first, retry, 'a preserved version yields a stable identity');
  assert.notEqual(first, bumped, 'a real change yields a new identity');
});

// ---------------------------------------------------------------------------
// Handler atomicity (11-16)
// ---------------------------------------------------------------------------

function handlerOn(pool) {
  return buildAriHandlers({ withAriUnit: (t, cb) => withTenantAriUnit(pool, t, cb) });
}
const RULE_REQ = {
  ctx: { tenantId: TENANT_A, propertyId: PROPERTY },
  body: { id: 'rr-1', level: 'property', date_from: '2026-09-01', date_to: '2026-09-30', minLos: 2 }
};
function fakeRes() {
  return { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(b) { this._json = b; return this; } };
}

test('11. the mutation and the enqueue run on the SAME client in ONE transaction', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await handlerOn(pool).upsertRestrictionRule(RULE_REQ, fakeRes());
  assert.equal(state.connects, 1);
  assert.equal(state.begins, 1);
  assert.equal(state.commits, 1);
  assert.equal(state.rollbacks, 0);
  assert.equal(new Set(state.statements.map((s) => s.clientId)).size, 1);
});

test('12. an enqueue failure rolls the restriction mutation back', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A, failOn: (kind) => kind === 'outbox' });
  const res = fakeRes();
  await handlerOn(pool).upsertRestrictionRule(RULE_REQ, res);
  assert.equal(res._status, 500, 'the error is surfaced, never swallowed');
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
});

test('13. a mutation failure prevents any enqueue', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A, failOn: (kind) => kind === 'restriction' });
  await handlerOn(pool).upsertRestrictionRule(RULE_REQ, fakeRes());
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(outboxRows(state).length, 0);
});

test('14. cross-tenant nested reuse fails with TENANT_CONTEXT_MISMATCH and issues no SQL', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(
    () => runWithTenantTransaction(pool, TENANT_A, () => withTenantAriUnit(pool, TENANT_B, () => {})),
    (e) => e.code === ERR.TENANT_CONTEXT_MISMATCH
  );
  assert.equal(state.statements.length, 0);
});

test('15. a missing propertyId fails BEFORE the mutation', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const res = fakeRes();
  await handlerOn(pool).upsertRestrictionRule({ ctx: { tenantId: TENANT_A }, body: { id: 'rr-1', level: 'property', date_from: '2026-09-01', date_to: '2026-09-30' } }, res);
  assert.equal(res._status, 400);
  assert.equal(res._json.error, 'property_required');
  assert.equal(state.connects, 0);
});

test('16/17. invalid version, invalid dates and secret-like payload keys all fail before outbox SQL', async () => {
  const bad = [
    [{ sourceVersion: 0 }, /sourceVersion must be a positive integer/],
    [{ effectiveTo: '2026-09-01' }, /effective period invalid/],
    [{ payload: { nested: { apiKey: 'x' } } }, /must not contain secret material/]
  ];
  for (const [over, re] of bad) {
    const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
    await assert.rejects(() => withTenantAriUnit(pool, TENANT_A, ({ outbox }) => outbox.enqueue(Object.assign({
      tenantId: TENANT_A, propertyId: PROPERTY,
      eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY',
      restrictionRuleId: 'rr-1', level: 'property',
      roomTypeId: null, ratePlanId: null, channel: null,
      effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', sourceVersion: 1
    }, over))), re);
    assert.equal(outboxRows(state).length, 0);
  }
});

// ---------------------------------------------------------------------------
// Version disjointness at the validator level (19/20) and boundaries (21/22)
// ---------------------------------------------------------------------------

test('19. a restriction event cannot be forced to carry a v1 key', async () => {
  const { pool } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(() => withTenantAriUnit(pool, TENANT_A, ({ outbox }) => outbox.enqueue({
    tenantId: TENANT_A, propertyId: PROPERTY,
    eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY',
    restrictionRuleId: 'rr-1', level: 'property',
    roomTypeId: null, ratePlanId: null, channel: null,
    effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', sourceVersion: 1,
    dedupeKey: buildAriDedupeKey({
      eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY', roomTypeId: 'rt1',
      ratePlanId: null, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', sourceVersion: 1
    })
  })), /does not match the canonical restriction identity/);
});

test('20. a non-restriction event cannot be forced to carry a v2 key', async () => {
  const { pool } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(() => withTenantAriUnit(pool, TENANT_A, ({ outbox }) => outbox.enqueue({
    tenantId: TENANT_A, propertyId: PROPERTY,
    eventType: 'INVENTORY_CHANGED', resourceKind: 'INVENTORY', roomTypeId: 'rt1',
    ratePlanId: null, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-02', sourceVersion: 1,
    dedupeKey: k({})
  })), /dedupeKey does not match the canonical identity/);
});

test('a restriction event with the wrong event type or resource kind fails closed', async () => {
  const { pool } = makeFakePool({ boundTenantId: TENANT_A });
  for (const [over, re] of [
    [{ eventType: 'INVENTORY_CHANGED' }, /must be AVAILABILITY_CHANGED/],
    [{ resourceKind: 'INVENTORY' }, /must carry resourceKind AVAILABILITY/],
    [{ level: 'nonsense' }, /level invalid/]
  ]) {
    await assert.rejects(() => withTenantAriUnit(pool, TENANT_A, ({ outbox }) => outbox.enqueue(Object.assign({
      tenantId: TENANT_A, propertyId: PROPERTY,
      eventType: 'AVAILABILITY_CHANGED', resourceKind: 'AVAILABILITY',
      restrictionRuleId: 'rr-1', level: 'property',
      roomTypeId: null, ratePlanId: null, channel: null,
      effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', sourceVersion: 1
    }, over))), re);
  }
});

test('21/22. no channel_sync_queue_store statement and no reservation_id parameter is ever issued', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await handlerOn(pool).upsertRestrictionRule(RULE_REQ, fakeRes());
  for (const s of state.statements) {
    assert.ok(!/channel_sync_queue_store/i.test(s.sql));
    assert.ok(!/reservation_id/i.test(s.sql));
  }
});

test('the enqueued event carries the persisted configured values in its payload, and no secret', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await handlerOn(pool).upsertRestrictionRule(RULE_REQ, fakeRes());
  const payload = outboxRows(state)[0].params[10];
  assert.equal(payload.restrictionRuleId, 'rr-1');
  assert.equal(payload.level, 'property');
  assert.equal(payload.minLos, 2);
  assert.equal(payload.source, 'ari_api');
  assert.ok(!/password|token|secret|apiKey/i.test(JSON.stringify(payload)));
});
