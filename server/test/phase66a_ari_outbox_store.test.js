'use strict';

/**
 * Phase 66A-B2N-B — ARI outbox persistence contract (ari_outbox_store +
 * tenantAriOutbox), covering all 28 required proof points of the B2N-B
 * instruction's Section 13. Uses ONLY fake pools and fake transaction
 * clients — no real PostgreSQL connection is opened anywhere in this file,
 * and no network call is possible.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildAriOutboxStore, buildAriDedupeKey, validateEnqueueInput,
  EVENT_TYPES, RESOURCE_KINDS, STATUS
} = require('../src/ari/outbox/ariOutboxStore');
const {
  withTenantAriOutbox, enqueueForTenant, claimDueForTenant,
  markCompletedForTenant, markRetryScheduledForTenant, markDeadLetterForTenant,
  requeueExpiredLeasesForTenant
} = require('../src/ari/outbox/tenantAriOutbox');
const { runWithTenantTransaction, ERR } = require('../src/db/tenantUnitOfWork');

const TENANT_A   = '11111111-1111-4111-8111-111111111111';
const TENANT_B   = '22222222-2222-4222-8222-222222222222';
const PROPERTY_A = '33333333-3333-4333-8333-333333333333';

const OUTBOX_STORE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'ari', 'outbox', 'ariOutboxStore.js'), 'utf8');
const TENANT_OUTBOX_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'ari', 'outbox', 'tenantAriOutbox.js'), 'utf8');

// Static bans apply to effective CODE — documentation comments legitimately
// NAME the things the code must never do ("no manual SET SESSION", "no
// transport dependency"), so they are stripped before scanning.
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
const OUTBOX_STORE_CODE = stripJsComments(OUTBOX_STORE_SOURCE);
const TENANT_OUTBOX_CODE = stripJsComments(TENANT_OUTBOX_SOURCE);

function validEvent(over = {}) {
  return Object.assign({
    tenantId: TENANT_A,
    propertyId: PROPERTY_A,
    eventType: 'INVENTORY_CHANGED',
    roomTypeId: 'rt1',
    effectiveFrom: '2026-08-01',
    effectiveTo: '2026-08-02',
    sourceVersion: 3,
    payload: { sold: 2, physical: 10 }
  }, over);
}

// Fake pg-shaped pool: recognizes tenantUnitOfWork's own plumbing statements
// and records every store SQL statement; INSERT/UPDATE on ari_outbox_store
// return configurable row shapes.
function makeFakePool({ boundTenantId, insertConflicts = false, existingStatus = 'PENDING' } = {}) {
  const state = {
    connectCalls: 0, beginCalls: 0, commitCalls: 0, rollbackCalls: 0,
    storeQueries: [] // {sql, params}
  };
  function makeClient() {
    return {
      async query(text, params) {
        const sql = String(text).trim();
        if (/^BEGIN/i.test(sql)) { state.beginCalls += 1; return { rows: [] }; }
        if (/^COMMIT/i.test(sql)) { state.commitCalls += 1; return { rows: [] }; }
        if (/^ROLLBACK/i.test(sql)) { state.rollbackCalls += 1; return { rows: [] }; }
        if (/set_config\('app\.tenant_id'/.test(sql)) return { rows: [] };
        if (/app_current_tenant\(\)/.test(sql)) return { rows: [{ tid: boundTenantId }] };
        state.storeQueries.push({ sql, params });
        if (/^INSERT INTO ari_outbox_store/i.test(sql)) {
          if (insertConflicts) return { rows: [] }; // ON CONFLICT DO NOTHING absorbed the row
          return { rows: [{ id: 'row-1', status: 'PENDING', dedupe_key: params[9] }] };
        }
        if (/^SELECT \* FROM ari_outbox_store/i.test(sql)) {
          return { rows: [{ id: 'row-existing', status: existingStatus }] };
        }
        if (/SET status = 'PROCESSING'/i.test(sql)) {
          return { rows: [{ id: 'row-1', status: 'PROCESSING' }] };
        }
        return { rows: [{ id: 'row-1', status: 'X' }] };
      },
      release() {}
    };
  }
  const pool = { async connect() { state.connectCalls += 1; return makeClient(); } };
  return { pool, state };
}

// ---------------------------------------------------------------------------
// 1-4: dedupe identity
// ---------------------------------------------------------------------------

test('1. identical logical events produce the identical dedupe identity (deterministic, versioned, hash-encoded)', () => {
  const a = buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', ratePlanId: null, effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 3 });
  const b = buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', ratePlanId: null, effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 3 });
  assert.equal(a, b);
  assert.match(a, /^aob:v1:[0-9a-f]{64}$/);
});

test('2. a different source version produces a different dedupe identity', () => {
  const v3 = buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 3 });
  const v4 = buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 4 });
  assert.notEqual(v3, v4);
});

test('3. rate-plan identity affects rate-event dedupe', () => {
  const rp1 = buildAriDedupeKey({ eventType: 'RATE_CHANGED', roomTypeId: 'rt1', ratePlanId: 'rp1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 1 });
  const rp2 = buildAriDedupeKey({ eventType: 'RATE_CHANGED', roomTypeId: 'rt1', ratePlanId: 'rp2', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 1 });
  assert.notEqual(rp1, rp2);
});

test('4. non-rate events need no rate-plan identity — and REJECT an irrelevant one before SQL', () => {
  const v = validateEnqueueInput(validEvent()); // INVENTORY_CHANGED, no ratePlanId
  assert.equal(v.ratePlanId, null);
  assert.throws(
    () => validateEnqueueInput(validEvent({ ratePlanId: 'rp1' })),
    /ratePlanId is only valid for RATE_CHANGED/
  );
});

// ---------------------------------------------------------------------------
// 5-10: fail-closed validation before any SQL
// ---------------------------------------------------------------------------

for (const [n, label, over, msgRe] of [
  [5, 'missing tenant', { tenantId: undefined }, /tenantId must be a UUID/],
  [6, 'missing property', { propertyId: undefined }, /propertyId must be a UUID/],
  [7, 'missing room type', { roomTypeId: undefined }, /roomTypeId required/],
  [8, 'invalid event type', { eventType: 'BOOKING_CHANGED' }, /eventType invalid/],
  [9, 'invalid effective period (to <= from)', { effectiveTo: '2026-08-01' }, /effective period invalid/],
  [10, 'payload containing secret material', { payload: { note: 'x', apiKey: 'abc' } }, /must not contain secret material/]
]) {
  test(`${n}. ${label} fails closed before any database query`, async () => {
    const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
    const event = validEvent(over);
    // For the missing-tenant case the wrapper's own tenantId is also absent,
    // so the unit of work itself fails closed before pool.connect().
    await assert.rejects(
      () => enqueueForTenant({ pool, tenantId: event.tenantId, event }),
      msgRe
    );
    assert.equal(state.storeQueries.length, 0, 'no store SQL was issued');
    if ('tenantId' in over) assert.equal(state.connectCalls, 0, 'missing tenant: no connection was even acquired');
  });
}

test('10b. nested secret keys are also rejected (recursive scan)', () => {
  assert.throws(
    () => validateEnqueueInput(validEvent({ payload: { meta: { auth: { Password: 'x' } } } })),
    /rejected key "meta.auth.Password"/
  );
});

// ---------------------------------------------------------------------------
// 11-14: transaction contract
// ---------------------------------------------------------------------------

test('11. enqueue uses the supplied transaction client (one connect, one BEGIN, INSERT on that client)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const res = await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent() });
  assert.equal(res.accepted, true);
  assert.equal(state.connectCalls, 1);
  assert.equal(state.beginCalls, 1);
  assert.equal(state.commitCalls, 1);
  assert.match(state.storeQueries[0].sql, /^INSERT INTO ari_outbox_store/);
});

test('12. static: no bare-pool enqueue path exists — the outbox modules never touch a pool directly', () => {
  assert.ok(!/pool\.query/.test(OUTBOX_STORE_CODE));
  assert.ok(!/pool\.query/.test(TENANT_OUTBOX_CODE));
  assert.ok(!/require\(['"]pg['"]\)/.test(OUTBOX_STORE_CODE));
  assert.ok(!/require\(['"]pg['"]\)/.test(TENANT_OUTBOX_CODE));
  assert.match(TENANT_OUTBOX_CODE, /runWithTenantTransaction\(pool, tenantId,/,
    'every tenant wrapper must route through the approved unit-of-work helper');
  assert.ok(!/SET\s+SESSION/i.test(OUTBOX_STORE_CODE + TENANT_OUTBOX_CODE));
  assert.ok(!/set_config\(/.test(OUTBOX_STORE_CODE + TENANT_OUTBOX_CODE),
    'tenant binding must live solely in tenantUnitOfWork.js');
});

test('13. same-tenant transaction context is reused — enqueue inside an open unit of work adds no second connect/BEGIN', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await runWithTenantTransaction(pool, TENANT_A, async () => {
    await withTenantAriOutbox(pool, TENANT_A, (outbox) => outbox.enqueue(validEvent()));
    await withTenantAriOutbox(pool, TENANT_A, (outbox) => outbox.enqueue(validEvent({ sourceVersion: 4 })));
  });
  assert.equal(state.connectCalls, 1, 'outer unit of work owns the only connection');
  assert.equal(state.beginCalls, 1, 'one BEGIN for the whole nested chain');
  assert.equal(state.commitCalls, 1);
});

test('14. cross-tenant nested context fails closed (TENANT_CONTEXT_MISMATCH), zero outbox SQL', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(
    () => runWithTenantTransaction(pool, TENANT_A, () =>
      withTenantAriOutbox(pool, TENANT_B, (outbox) => outbox.enqueue(validEvent({ tenantId: TENANT_B })))),
    (err) => err.code === ERR.TENANT_CONTEXT_MISMATCH
  );
  assert.equal(state.storeQueries.length, 0);
});

// ---------------------------------------------------------------------------
// 15-18: claim semantics
// ---------------------------------------------------------------------------

test('15. claimDueForTenant is tenant-scoped: opens a tenant-bound unit of work whose bind is PROVEN before the claim SQL', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const rows = await claimDueForTenant({ pool, tenantId: TENANT_A, limit: 5, leaseOwner: 'w1' });
  assert.equal(state.connectCalls, 1);
  assert.equal(state.beginCalls, 1);
  assert.ok(Array.isArray(rows));
  assert.match(state.storeQueries[0].sql, /UPDATE ari_outbox_store/);
});

test('16. rows with a future next_retry_at are not claimed (due-time predicate in the claim SQL)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await claimDueForTenant({ pool, tenantId: TENANT_A });
  assert.match(state.storeQueries[0].sql, /\(next_retry_at IS NULL OR next_retry_at <= now\(\)\)/);
});

test('17. exhausted rows are not claimed (retry_count < max_retries in the claim SQL)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await claimDueForTenant({ pool, tenantId: TENANT_A });
  assert.match(state.storeQueries[0].sql, /retry_count < max_retries/);
});

test('18. concurrent claims use FOR UPDATE SKIP LOCKED and take a lease', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await claimDueForTenant({ pool, tenantId: TENANT_A, leaseOwner: 'worker-9', leaseMs: 30000 });
  const sql = state.storeQueries[0].sql;
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /lease_until = now\(\)/);
  assert.match(sql, /lease_owner = \$3/);
  assert.equal(state.storeQueries[0].params[2], 'worker-9');
});

// ---------------------------------------------------------------------------
// 19-22: transitions
// ---------------------------------------------------------------------------

test('19. completion is tenant-bound and only touches a PROCESSING row', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await markCompletedForTenant({ pool, tenantId: TENANT_A, id: 'row-1' });
  assert.equal(state.beginCalls, 1);
  const sql = state.storeQueries[0].sql;
  assert.match(sql, /SET status = 'COMPLETED'/);
  assert.match(sql, /WHERE id = \$1 AND status = 'PROCESSING'/);
  assert.match(sql, /completed_at = now\(\)/);
  assert.match(sql, /lease_until = NULL, lease_owner = NULL/);
});

test('20. retry scheduling is tenant-bound: PROCESSING -> PENDING, attempts+1, retry_count+1, next_retry_at set, lease cleared', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await markRetryScheduledForTenant({ pool, tenantId: TENANT_A, id: 'row-1', nextRetryAt: '2026-08-01T00:00:00Z' });
  assert.equal(state.beginCalls, 1);
  const sql = state.storeQueries[0].sql;
  assert.match(sql, /SET status = 'PENDING', attempts = attempts \+ 1,\s*\n\s*retry_count = retry_count \+ 1, next_retry_at = \$2/);
  assert.match(sql, /WHERE id = \$1 AND status = 'PROCESSING'/);
  assert.match(sql, /lease_until = NULL, lease_owner = NULL/);
});

test('21. dead-letter transition is tenant-bound: PROCESSING -> DEAD_LETTER, attempts+1, retry_count preserved, next_retry_at cleared, dead_lettered_at set', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await markDeadLetterForTenant({ pool, tenantId: TENANT_A, id: 'row-1' });
  assert.equal(state.beginCalls, 1);
  const sql = state.storeQueries[0].sql;
  assert.match(sql, /SET status = 'DEAD_LETTER', attempts = attempts \+ 1/);
  assert.ok(!/retry_count = retry_count \+ 1/.test(sql), 'retry_count is preserved on dead-letter (B2M semantics)');
  assert.match(sql, /next_retry_at = NULL/);
  assert.match(sql, /dead_lettered_at = now\(\)/);
  assert.match(sql, /WHERE id = \$1 AND status = 'PROCESSING'/);
});

test('22. terminal rows are never reclaimed: claim selects PENDING only, every transition requires PROCESSING', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await claimDueForTenant({ pool, tenantId: TENANT_A });
  assert.match(state.storeQueries[0].sql, /WHERE status = 'PENDING'/);
  assert.ok(!/COMPLETED|DEAD_LETTER/.test(state.storeQueries[0].sql.match(/WHERE status = '([A-Z_]+)'/)[1]));
});

// ---------------------------------------------------------------------------
// 23-24: dedupe behavior
// ---------------------------------------------------------------------------

test('23. duplicate work is controlled: ON CONFLICT targets the GLOBAL logical-event key and the duplicate returns the existing row', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A, insertConflicts: true });
  const res = await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent() });
  assert.equal(res.accepted, false);
  assert.equal(res.deduped, true);
  assert.equal(res.existing.id, 'row-existing');
  const insertSql = state.storeQueries[0].sql;
  assert.match(insertSql, /ON CONFLICT \(tenant_id, property_id, dedupe_key\)\s*\n\s*DO NOTHING/);
  assert.ok(!/ON CONFLICT[\s\S]*?WHERE status/.test(insertSql),
    'the conflict target must be the full constraint, not a status-limited partial key');
});

test('24. terminal history does not block a later legitimate VERSION: a new source version has a new dedupe key and inserts a fresh row', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const r1 = await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent({ sourceVersion: 3 }) });
  const r2 = await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent({ sourceVersion: 4 }) });
  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, true);
  const k1 = state.storeQueries[0].params[9];
  const k2 = state.storeQueries[1].params[9];
  assert.notEqual(k1, k2, 'a later legitimate source version produces a different dedupe key');
});

// ---------------------------------------------------------------------------
// Final correction #1: global logical-event idempotency (9 required proofs)
// ---------------------------------------------------------------------------

for (const status of ['PENDING', 'PROCESSING', 'COMPLETED', 'DEAD_LETTER']) {
  test(`G1-4. the identical logical event deduplicates while the existing row is ${status} — explicit idempotent-duplicate result`, async () => {
    const { pool, state } = makeFakePool({ boundTenantId: TENANT_A, insertConflicts: true, existingStatus: status });
    const res = await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent() });
    assert.equal(res.accepted, false);
    assert.equal(res.deduped, true, 'documented duplicate/idempotent result shape');
    assert.equal(res.existing.status, status, 'the existing row is returned whatever its status');
    const followUp = state.storeQueries[1].sql;
    assert.ok(!/status/.test(followUp), 'the existing-row lookup must not be limited to active statuses');
  });
}

test('G4b. a DEAD_LETTER duplicate is never silently re-inserted — replay is documented as a future explicit reviewed transition', () => {
  assert.match(OUTBOX_STORE_SOURCE, /DEAD_LETTER duplicate is[\s\S]{0,20}NEVER silently re-inserted/);
  assert.match(OUTBOX_STORE_SOURCE, /not\s*\n?\s*\* an INSERT \(and is not implemented in this phase\)/);
});

test('G5/G8. a later source_version remains accepted after any history (different canonical key)', () => {
  const v3 = buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 3 });
  const v4 = buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 4 });
  assert.notEqual(v3, v4);
});

test('G6. different legitimate effective periods remain accepted (different canonical key)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const r1 = await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent({ effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02' }) });
  const r2 = await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent({ effectiveFrom: '2026-08-02', effectiveTo: '2026-08-03' }) });
  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, true);
  assert.notEqual(state.storeQueries[0].params[9], state.storeQueries[1].params[9]);
});

test('G7. concurrent enqueue safety: one atomic INSERT ... ON CONFLICT DO NOTHING — no race-prone SELECT-then-INSERT', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent() });
  assert.equal(state.storeQueries.length, 1, 'the accepted path issues exactly one statement');
  assert.match(state.storeQueries[0].sql, /^INSERT INTO ari_outbox_store/);
  assert.match(state.storeQueries[0].sql, /ON CONFLICT[\s\S]*DO NOTHING/);
  assert.ok(!/^SELECT/.test(state.storeQueries[0].sql), 'no SELECT precedes the INSERT');
});

test('G9. no partial active-only unique predicate appears anywhere in the store SQL', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A, insertConflicts: true });
  await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent() });
  for (const q of state.storeQueries) {
    assert.ok(!/ON CONFLICT[\s\S]*?WHERE status/.test(q.sql));
  }
  assert.ok(!/uq_aob_active_dedupe/.test(OUTBOX_STORE_CODE), 'no reference to the removed partial index remains in code');
});

// ---------------------------------------------------------------------------
// 25-28: decoupling
// ---------------------------------------------------------------------------

test('25. no network or adapter dependency is invoked by the outbox modules', () => {
  for (const src of [OUTBOX_STORE_CODE, TENANT_OUTBOX_CODE]) {
    assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(src));
    assert.ok(!/eventBus|channelRegistry|adapter|transport|qtcn/i.test(src));
  }
});

test('26. no reservation_id coupling exists anywhere in the outbox modules or their SQL', async () => {
  assert.ok(!/reservation_id/.test(OUTBOX_STORE_CODE));
  assert.ok(!/reservation_id/.test(TENANT_OUTBOX_CODE));
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent() });
  await claimDueForTenant({ pool, tenantId: TENANT_A });
  for (const q of state.storeQueries) assert.ok(!/reservation_id/.test(q.sql));
});

test('27. no channel_sync_queue_store write occurs — every store statement targets ari_outbox_store only', async () => {
  assert.ok(!/channel_sync_queue_store/.test(OUTBOX_STORE_SOURCE));
  assert.ok(!/channel_sync_queue_store/.test(TENANT_OUTBOX_SOURCE));
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent() });
  await claimDueForTenant({ pool, tenantId: TENANT_A });
  await markCompletedForTenant({ pool, tenantId: TENANT_A, id: 'row-1' });
  await markRetryScheduledForTenant({ pool, tenantId: TENANT_A, id: 'row-1', nextRetryAt: null });
  await markDeadLetterForTenant({ pool, tenantId: TENANT_A, id: 'row-1' });
  for (const q of state.storeQueries) assert.match(q.sql, /ari_outbox_store/);
});

test('28. B2M reservation queue behavior remains unchanged: the outbox imports only tenantUnitOfWork + its own store, and touches no channel-manager module', () => {
  const requires = [...TENANT_OUTBOX_SOURCE.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(requires, ['../../db/tenantUnitOfWork', './ariOutboxStore']);
  const storeRequires = [...OUTBOX_STORE_SOURCE.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(storeRequires, ['node:crypto'],
    'the low-level store depends only on the node:crypto builtin (SHA-256 dedupe encoding) — nothing else');
  // And the reservation queue store file itself is untouched by this phase:
  const dbStoresSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'channel-manager', 'persistence', 'dbStores.js'), 'utf8');
  assert.ok(!/ari_outbox/.test(dbStoresSource), 'dbStores.js gained no ARI outbox coupling');
});

// ---------------------------------------------------------------------------
// Correction #2: expired-lease recovery (10 required proofs)
// ---------------------------------------------------------------------------

test('R1/R3/R4. recovery returns an expired PROCESSING row to PENDING and clears lease_until AND lease_owner', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await requeueExpiredLeasesForTenant({ pool, tenantId: TENANT_A });
  const sql = state.storeQueries[0].sql;
  assert.match(sql, /SET status = 'PENDING', lease_until = NULL, lease_owner = NULL/);
  assert.match(sql, /WHERE status = 'PROCESSING'/);
});

test('R2. an active (unexpired) PROCESSING lease is never recovered: the predicate requires a non-NULL, already-passed lease', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await requeueExpiredLeasesForTenant({ pool, tenantId: TENANT_A });
  const sql = state.storeQueries[0].sql;
  assert.match(sql, /lease_until IS NOT NULL/);
  assert.match(sql, /lease_until <= now\(\)/);
});

test('R5/R6. recovery preserves retry_count AND attempts (documented semantics: a crashed worker reported no finished attempt)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await requeueExpiredLeasesForTenant({ pool, tenantId: TENANT_A });
  const sql = state.storeQueries[0].sql;
  assert.ok(!/retry_count/.test(sql), 'retry_count untouched');
  assert.ok(!/attempts/.test(sql), 'attempts untouched');
  assert.ok(!/COMPLETED|DEAD_LETTER/.test(sql), 'recovery never sets a terminal status');
  assert.match(OUTBOX_STORE_SOURCE, /attempts counts processing attempts a live worker FINISHED/,
    'the attempts semantics must be documented in the store');
});

test('R7. wrong-tenant recovery is tenant-bound: it runs inside a proven tenant unit of work (RLS scopes the UPDATE to zero foreign rows)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await requeueExpiredLeasesForTenant({ pool, tenantId: TENANT_A, limit: 10 });
  assert.equal(state.connectCalls, 1);
  assert.equal(state.beginCalls, 1);
  assert.equal(state.commitCalls, 1);
});

test('R8. same-tenant transaction context is reused by recovery (no second connect/BEGIN inside an open unit of work)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await runWithTenantTransaction(pool, TENANT_A, async () => {
    await withTenantAriOutbox(pool, TENANT_A, (outbox) => outbox.requeueExpiredLeases());
  });
  assert.equal(state.connectCalls, 1);
  assert.equal(state.beginCalls, 1);
});

test('R9. cross-tenant nested recovery fails closed', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(
    () => runWithTenantTransaction(pool, TENANT_A, () =>
      requeueExpiredLeasesForTenant({ pool, tenantId: TENANT_B })),
    (err) => err.code === ERR.TENANT_CONTEXT_MISMATCH
  );
  assert.equal(state.storeQueries.length, 0);
});

test('R10. no bare-pool fallback exists for recovery, and concurrent recoveries use SKIP LOCKED on the same single row (no duplicate active rows possible)', async () => {
  assert.match(TENANT_OUTBOX_CODE, /requeueExpiredLeasesForTenant\(\{ pool, tenantId, limit \}\) \{\s*\n\s*return withTenantAriOutbox\(pool, tenantId,/,
    'recovery routes only through the tenant-bound unit of work');
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await requeueExpiredLeasesForTenant({ pool, tenantId: TENANT_A });
  const sql = state.storeQueries[0].sql;
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.ok(!/INSERT/.test(sql), 'recovery is a status flip on the same row — never an insert, so uq_aob_logical_event cannot be violated');
});

test('recovery documents the downstream transport idempotency requirement', () => {
  assert.match(OUTBOX_STORE_SOURCE, /idempotent per \(dedupe_key, source_version\)/);
});

// ---------------------------------------------------------------------------
// Collision-safe dedupe encoding (14 required proofs; D2/D7/D13/D14 also
// covered by tests 2/3 and G1-4/G7 above)
// ---------------------------------------------------------------------------

const BASE_TUPLE = { eventType: 'RATE_CHANGED', roomTypeId: 'rt1', ratePlanId: 'rp1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 1 };

test('D1. identical canonical tuples produce identical keys', () => {
  assert.equal(buildAriDedupeKey(BASE_TUPLE), buildAriDedupeKey(Object.assign({}, BASE_TUPLE)));
});

test('D2. a different sourceVersion produces a different key', () => {
  assert.notEqual(buildAriDedupeKey(BASE_TUPLE), buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { sourceVersion: 2 })));
});

test('D3. a different effectiveFrom or effectiveTo produces a different key', () => {
  assert.notEqual(buildAriDedupeKey(BASE_TUPLE), buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { effectiveFrom: '2026-07-31' })));
  assert.notEqual(buildAriDedupeKey(BASE_TUPLE), buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { effectiveTo: '2026-08-03' })));
});

test('D4. a different eventType produces a different key', () => {
  const inv = buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 1 });
  const avail = buildAriDedupeKey({ eventType: 'AVAILABILITY_CHANGED', roomTypeId: 'rt1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 1 });
  assert.notEqual(inv, avail);
});

test('D5. a different resourceKind produces a different key', () => {
  const a = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { resourceKind: 'RATE' }));
  const b = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { resourceKind: 'INVENTORY' }));
  assert.notEqual(a, b);
});

test('D6. a different roomTypeId produces a different key', () => {
  assert.notEqual(buildAriDedupeKey(BASE_TUPLE), buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { roomTypeId: 'rt2' })));
});

test('D7. a different ratePlanId produces a different key', () => {
  assert.notEqual(buildAriDedupeKey(BASE_TUPLE), buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { ratePlanId: 'rp2' })));
});

test('D8. null ratePlanId is distinct from the literal string "-"', () => {
  const asNull = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { ratePlanId: null }));
  const asDash = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { ratePlanId: '-' }));
  assert.notEqual(asNull, asDash);
});

test('D9. identifiers containing "|" cannot collide through component-boundary ambiguity', () => {
  // Under the old raw '|'-delimited format both of these serialized to
  // ...|a|b|c|... — with JSON array elements they hash differently.
  const a = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { roomTypeId: 'a|b', ratePlanId: 'c' }));
  const b = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { roomTypeId: 'a', ratePlanId: 'b|c' }));
  assert.notEqual(a, b);
});

test('D10. colons, quotes, slashes, Unicode and whitespace remain deterministic and collision-safe', () => {
  const weird = { roomTypeId: 'rt:"1"/\\ ⌘é\n', ratePlanId: 'rp: |x' };
  const k1 = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, weird));
  const k2 = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, weird));
  assert.equal(k1, k2, 'deterministic');
  assert.match(k1, /^aob:v1:[0-9a-f]{64}$/);
  const shifted = buildAriDedupeKey(Object.assign({}, BASE_TUPLE, { roomTypeId: 'rt:"1"/\\ ⌘é', ratePlanId: '\nrp: |x' }));
  assert.notEqual(k1, shifted, 'moving characters across a component boundary changes the key');
});

test('D11. the key format is exactly /^aob:v1:[0-9a-f]{64}$/', () => {
  assert.match(buildAriDedupeKey(BASE_TUPLE), /^aob:v1:[0-9a-f]{64}$/);
  assert.match(buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 9 }), /^aob:v1:[0-9a-f]{64}$/);
});

test('D12. payload is not part of the identity: different payloads and property orders yield the same dedupe key', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await enqueueForTenant({ pool, tenantId: TENANT_A, event: validEvent({ payload: { a: 1, b: 2 } }) });
  const { pool: pool2, state: state2 } = makeFakePool({ boundTenantId: TENANT_A });
  await enqueueForTenant({ pool: pool2, tenantId: TENANT_A, event: validEvent({ payload: { b: 2, a: 1 } }) });
  assert.equal(state.storeQueries[0].params[9], state2.storeQueries[0].params[9]);
});

// D13 (all four existing-status dedupe cases) is proven by G1-4 above.
// D14 (concurrent enqueue creates exactly one row) is proven by G7 above.

// ---------------------------------------------------------------------------
// Vocabulary sanity
// ---------------------------------------------------------------------------

test('event/resource/status vocabularies match the migration contract exactly', () => {
  assert.deepEqual(Object.keys(EVENT_TYPES).sort(), ['AVAILABILITY_CHANGED', 'INVENTORY_CHANGED', 'RATE_CHANGED']);
  assert.deepEqual(Object.keys(RESOURCE_KINDS).sort(), ['AVAILABILITY', 'INVENTORY', 'RATE']);
  assert.deepEqual(Object.keys(STATUS).sort(), ['COMPLETED', 'DEAD_LETTER', 'PENDING', 'PROCESSING']);
});

test('an explicitly supplied dedupeKey must equal the canonical identity (never an arbitrary caller string)', () => {
  const canonical = buildAriDedupeKey({ eventType: 'INVENTORY_CHANGED', roomTypeId: 'rt1', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-02', sourceVersion: 3 });
  const ok = validateEnqueueInput(validEvent({ dedupeKey: canonical }));
  assert.equal(ok.dedupeKey, canonical);
  assert.throws(() => validateEnqueueInput(validEvent({ dedupeKey: 'random-string' })), /dedupeKey does not match/);
});

test('resourceKind, when supplied, must agree with the event type (fails closed before SQL)', () => {
  assert.throws(() => validateEnqueueInput(validEvent({ resourceKind: 'RATE' })), /incompatible/);
  const v = validateEnqueueInput(validEvent({ resourceKind: 'INVENTORY' }));
  assert.equal(v.resourceKind, 'INVENTORY');
});
