'use strict';

/**
 * Phase 66A-B2N-A — ARI store tenant-bound unit-of-work remediation.
 *
 * Proves server/src/ari/store/tenantAriStore.js correctly binds every ARI
 * write (and read) to a tenant-bound transaction via the existing, unmodified
 * server/src/db/tenantUnitOfWork.js, and that booking-engine/
 * ariInventoryAdjuster.js's multi-night adjustment is atomic across all
 * nights. Uses ONLY fake pools/clients — no real PostgreSQL connection is
 * opened anywhere in this file, no network call is possible.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withTenantAriStore, withTenantAriRead } = require('../src/ari/store/tenantAriStore');
const { runWithTenantTransaction, ERR } = require('../src/db/tenantUnitOfWork');
const { buildAriInventoryAdjuster } = require('../src/booking-engine/ariInventoryAdjuster');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
// B2N-C1: the outbox requires a real UUID property (ari_outbox_store.
// property_id is NOT NULL with a composite same-tenant FK).
const PROPERTY_A = '33333333-3333-4333-8333-333333333333';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// A fake pg-shaped pool: .connect() returns a fake client whose .query()
// recognizes exactly the statements tenantUnitOfWork.js itself issues
// (BEGIN/set_config/app_current_tenant proof/COMMIT/ROLLBACK) and otherwise
// records the SQL text and returns a generic, harmless row shape sufficient
// for any ari/store/dbStore.js write/read to complete without erroring.
// ---------------------------------------------------------------------------
function makeFakePool({ boundTenantId, failOnQueryMatching } = {}) {
  const state = {
    connectCalls: 0,
    beginCalls: 0,
    commitCalls: 0,
    rollbackCalls: 0,
    releaseCalls: 0,
    storeQueries: [] // SQL text of everything that isn't UoW plumbing
  };

  function makeClient() {
    return {
      async query(text, params) {
        const sql = String(text).trim();
        if (/^BEGIN/i.test(sql)) { state.beginCalls += 1; return { rows: [] }; }
        if (/^COMMIT/i.test(sql)) { state.commitCalls += 1; return { rows: [] }; }
        if (/^ROLLBACK/i.test(sql)) { state.rollbackCalls += 1; return { rows: [] }; }
        if (/set_config\('app\.tenant_id'/.test(sql)) { return { rows: [] }; }
        if (/app_current_tenant\(\)/.test(sql)) {
          // Prove the bind exactly the way tenantUnitOfWork.js itself does.
          return { rows: [{ tid: boundTenantId }] };
        }
        state.storeQueries.push(sql);
        if (failOnQueryMatching && failOnQueryMatching(sql, state.storeQueries.length)) {
          throw new Error('simulated_store_query_failure');
        }
        // Generic row shape: enough for every ari/store/dbStore.js write/read
        // to complete — version bump / adjustSold's RETURNING sold,version,
        // and enough raw columns for the read-side model.make* mappers
        // (roomTypes/inventory) to not throw on a missing required field.
        //
        // Phase 66A-B2N-C2: putRestrictionRule now maps the RETURNED row
        // through model.makeRestrictionRule (identity and payload must
        // describe the persisted row, never the request), so the fake row
        // also carries the authoritative restriction fields that mapper
        // requires: id, level and the half-open date_from/date_to range.
        return {
          rows: [{
            version: state.storeQueries.length, sold: 1,
            property_id: 'p1', room_type_id: 'rt1', date: '2026-08-01',
            code: 'STD', name: 'Standard', total_units: 10,
            physical: 10, blocked: 0,
            id: 'r1', level: 'property',
            date_from: '2026-08-01', date_to: '2026-08-31'
          }]
        };
      },
      release(destroy) { state.releaseCalls += 1; }
    };
  }

  const pool = {
    async connect() {
      state.connectCalls += 1;
      return makeClient();
    }
  };

  return { pool, state };
}

// ---------------------------------------------------------------------------
// 1-3: tenant identity required, fails before any DB query
// ---------------------------------------------------------------------------

test('withTenantAriStore: missing tenantId fails before any pool.connect() call', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(() => withTenantAriStore(pool, undefined, () => { throw new Error('must not run'); }));
  assert.equal(state.connectCalls, 0, 'no connection was ever acquired for a missing tenant id');
});

test('withTenantAriStore: invalid (non-UUID) tenantId fails closed with TENANT_ID_INVALID, zero connects', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(
    () => withTenantAriStore(pool, 'not-a-uuid', () => { throw new Error('must not run'); }),
    (err) => err.code === ERR.TENANT_ID_INVALID
  );
  assert.equal(state.connectCalls, 0);
});

test('withTenantAriStore: blank tenantId fails closed, zero connects', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(() => withTenantAriStore(pool, '', () => { throw new Error('must not run'); }));
  assert.equal(state.connectCalls, 0);
});

// ---------------------------------------------------------------------------
// 4: standalone mutation opens exactly one tenant-bound transaction
// ---------------------------------------------------------------------------

test('withTenantAriStore: a standalone call opens exactly one connection, BEGIN, bind, COMMIT, release', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const result = await withTenantAriStore(pool, TENANT_A, async (store) => {
    return store.putRoomType({ tenant_id: TENANT_A, propertyId: 'p1', roomTypeId: 'rt1', code: 'STD', name: 'Standard', totalUnits: 10 });
  });
  assert.ok(result);
  assert.equal(state.connectCalls, 1);
  assert.equal(state.beginCalls, 1);
  assert.equal(state.commitCalls, 1);
  assert.equal(state.rollbackCalls, 0);
  assert.equal(state.releaseCalls, 1);
});

// ---------------------------------------------------------------------------
// 5-6: caller-supplied transaction is reused, never a second independent one
// ---------------------------------------------------------------------------

test('withTenantAriStore: nested inside an already-open unit of work for the SAME tenant reuses the client — no second connect, no second BEGIN', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  await runWithTenantTransaction(pool, TENANT_A, async () => {
    await withTenantAriStore(pool, TENANT_A, (store) => store.putRoomType({ tenant_id: TENANT_A, propertyId: 'p1', roomTypeId: 'rt1', code: 'STD', name: 'Standard', totalUnits: 10 }));
    await withTenantAriStore(pool, TENANT_A, (store) => store.putRatePlan({ tenant_id: TENANT_A, propertyId: 'p1', ratePlanId: 'rp1', roomTypeId: 'rt1', code: 'BAR', name: 'x', currency: 'USD', baseRate: 100 }));
  });
  assert.equal(state.connectCalls, 1, 'only the OUTER runWithTenantTransaction ever acquired a connection');
  assert.equal(state.beginCalls, 1, 'only one BEGIN for the whole nested chain');
  assert.equal(state.commitCalls, 1);
});

test('withTenantAriStore: a unit of work for a DIFFERENT tenant while one is already open is rejected (never silently shares a transaction cross-tenant)', async () => {
  const { pool } = makeFakePool({ boundTenantId: TENANT_A });
  await assert.rejects(
    () => runWithTenantTransaction(pool, TENANT_A, () => withTenantAriStore(pool, TENANT_B, () => {})),
    (err) => err.code === ERR.TENANT_CONTEXT_MISMATCH
  );
});

// ---------------------------------------------------------------------------
// 7: no ARI write uses the boot-level bare pool (static source checks)
// ---------------------------------------------------------------------------

const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const HANDLERS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'ari', 'api', 'ari.handlers.js'), 'utf8');
const ADJUSTER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'booking-engine', 'ariInventoryAdjuster.js'), 'utf8');

test('static: the boot path constructs the inventory adjuster with withAriStore, not the bare-pool-bound ariDbStore', () => {
  assert.match(INDEX_SOURCE, /buildAriInventoryAdjuster\(\{\s*withAriStore\s*\}\)/);
  assert.ok(!/buildAriInventoryAdjuster\(\{\s*ariStore:\s*ariDbStore\s*\}\)/.test(INDEX_SOURCE),
    'the old bare-pool-bound construction must no longer exist');
});

test('static: ari.handlers.js write handlers route through the tenant-bound unit, not a direct store.putX call on the singleton ariStore', () => {
  // Phase 66A-B2N-C1 renamed the seam from _withAriStore to _withAriUnit: the
  // callback now receives { ariStore, outbox } built from the SAME
  // transaction client, so a mutation and its outbox event are atomic. The
  // invariant this test guards — writes never touch the boot-level singleton
  // — is unchanged.
  assert.match(HANDLERS_SOURCE, /const _withAriUnit = withAriUnit \|\| \(pool \? \(tenantId, callback\) => withTenantAriUnit\(pool, tenantId, callback\) : null\)/);
  assert.ok(!/ariStore\.putRoomType/.test(HANDLERS_SOURCE));
  assert.ok(!/ariStore\.putRatePlan/.test(HANDLERS_SOURCE));
  assert.ok(!/ariStore\.putInventoryCell/.test(HANDLERS_SOURCE));
  assert.ok(!/ariStore\.adjustSold/.test(HANDLERS_SOURCE));
  assert.ok(!/ariStore\.putRestrictionRule/.test(HANDLERS_SOURCE));
});

test('static: ariInventoryAdjuster.js no longer accepts a raw ariStore and never requires from ari/', () => {
  assert.match(ADJUSTER_SOURCE, /function buildAriInventoryAdjuster\(\{ withAriStore \} = \{\}\)/);
  assert.ok(!/require\(['"][^'"]*\/ari\//.test(ADJUSTER_SOURCE), 'must not require from ari/');
});

// ---------------------------------------------------------------------------
// 8-13: every authoritative write method uses the transaction-bound client
// ---------------------------------------------------------------------------

const WRITE_METHOD_CALLS = [
  ['putInventoryCell', (store) => store.putInventoryCell({ tenant_id: TENANT_A, propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', physical: 10, sold: 0, blocked: 0 })],
  ['updateInventoryOptimistic', (store) => store.updateInventoryOptimistic({ tenant_id: TENANT_A, propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', patch: { sold: 1 }, expectedVersion: 1 })],
  ['adjustSold', (store) => store.adjustSold({ tenant_id: TENANT_A, propertyId: 'p1', roomTypeId: 'rt1', date: '2026-08-01', delta: 1 })],
  ['putRatePlan', (store) => store.putRatePlan({ tenant_id: TENANT_A, propertyId: 'p1', ratePlanId: 'rp1', roomTypeId: 'rt1', code: 'BAR', name: 'x', currency: 'USD', baseRate: 100 })],
  ['putRestrictionRule', (store) => store.putRestrictionRule({ tenant_id: TENANT_A, id: 'r1', propertyId: 'p1', level: 'property', date_from: '2026-08-01', date_to: '2026-08-31' })],
  ['putRoomType', (store) => store.putRoomType({ tenant_id: TENANT_A, propertyId: 'p1', roomTypeId: 'rt1', code: 'STD', name: 'Standard', totalUnits: 10 })]
];

for (const [name, call] of WRITE_METHOD_CALLS) {
  test(`${name} executes through the transaction-bound client (one connect, one BEGIN, one COMMIT, real bind proof)`, async () => {
    const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
    await withTenantAriStore(pool, TENANT_A, call);
    assert.equal(state.connectCalls, 1);
    assert.equal(state.beginCalls, 1);
    assert.equal(state.commitCalls, 1);
    assert.ok(state.storeQueries.length >= 1, `${name} must have issued at least one SQL statement on the bound client`);
  });
}

// ---------------------------------------------------------------------------
// 14-16: multi-night adjustSold atomicity
// ---------------------------------------------------------------------------

test('ariInventoryAdjuster + real withTenantAriStore: a 3-night adjustment opens exactly ONE transaction for all three nights', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  const withAriStore = (tenantId, callback) => withTenantAriStore(pool, tenantId, callback);
  const adjuster = buildAriInventoryAdjuster({ withAriStore });

  await adjuster.adjustSold({
    tenantId: TENANT_A, propertyId: PROPERTY_A, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-04', delta: 1
  });

  assert.equal(state.connectCalls, 1, 'exactly one connection for the whole multi-night adjustment');
  assert.equal(state.beginCalls, 1, 'exactly one transaction for all three nights');
  assert.equal(state.commitCalls, 1);
  // Phase 66A-B2N-C1: each night now ALSO enqueues its INVENTORY_CHANGED
  // event on the same client — 3 adjustSold UPDATEs + 3 outbox INSERTs, all
  // still inside the ONE transaction this test exists to prove.
  const adjusts = state.storeQueries.filter((q) => /UPDATE ari_inventory_grid/i.test(q));
  const events  = state.storeQueries.filter((q) => /INSERT INTO ari_outbox_store/i.test(q));
  assert.equal(adjusts.length, 3, 'one adjustSold SQL statement per night');
  assert.equal(events.length, 3, 'one outbox event per night, in the same transaction');
});

test('ariInventoryAdjuster + real withTenantAriStore: a failure on the middle night rolls back the WHOLE multi-night adjustment', async () => {
  // Fail the SECOND night's adjustSold specifically. Counting only
  // ari_inventory_grid UPDATEs keeps this anchored on "the 2nd night" now
  // that each night also issues an outbox INSERT (B2N-C1).
  let nthAdjust = 0;
  const { pool, state } = makeFakePool({
    boundTenantId: TENANT_A,
    failOnQueryMatching: (sql) => /UPDATE ari_inventory_grid/i.test(sql) && ++nthAdjust === 2
  });
  const withAriStore = (tenantId, callback) => withTenantAriStore(pool, tenantId, callback);
  const adjuster = buildAriInventoryAdjuster({ withAriStore });

  await assert.rejects(() => adjuster.adjustSold({
    tenantId: TENANT_A, propertyId: PROPERTY_A, roomTypeId: 'rt1',
    arrival: '2026-08-01', departure: '2026-08-04', delta: 1 // 3 nights
  }));

  assert.equal(state.commitCalls, 0, 'no commit occurred — the failure rolled back the whole unit');
  assert.equal(state.rollbackCalls, 1);
  const adjusts = state.storeQueries.filter((q) => /UPDATE ari_inventory_grid/i.test(q));
  const events  = state.storeQueries.filter((q) => /INSERT INTO ari_outbox_store/i.test(q));
  assert.equal(adjusts.length, 2, 'the 3rd (later) night never ran after the 2nd night failed');
  assert.equal(events.length, 1, 'only the first night had emitted its event — and it rolled back too');
});

// ---------------------------------------------------------------------------
// 17-19: trusted tenant source, bookingService/holdExpirySweep call contracts
// ---------------------------------------------------------------------------

test('static: write handlers always pass the trusted ctx-derived tenantId to _withAriStore, never req.body.tenant_id', () => {
  // Every write handler's Object.assign places tenant_id: tenantId LAST,
  // so a client-supplied body.tenant_id can never win.
  const assigns = HANDLERS_SOURCE.match(/Object\.assign\(\{\}, rawBody, \{ tenant_id: tenantId,[^}]*\}\)/g) || [];
  assert.ok(assigns.length >= 5, 'expected every write handler to override tenant_id with the trusted ctx value');
});

test('static: the single-cell adjustSold HTTP handler uses the trusted tenantId, not body.tenant_id', () => {
  const fnBody = HANDLERS_SOURCE.slice(HANDLERS_SOURCE.indexOf('async function adjustSold'), HANDLERS_SOURCE.indexOf('async function upsertRateRule'));
  assert.match(fnBody, /tenant_id:\s*tenantId,/);
  assert.ok(!/tenant_id:\s*body\.tenant_id/.test(fnBody), 'must not allow the request body to override the trusted tenant id');
});

test('static: payment/holdExpirySweep.js makes no ARI mutation call at all — confirmed absent, not touched', () => {
  const sweepSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payment', 'holdExpirySweep.js'), 'utf8');
  // The file's own comment documents the disclosed finding ("ARI adjustSold is
  // NOT called here..."); what matters is there is no actual invocation/DI of
  // an adjuster or store, not that the word never appears in prose.
  assert.ok(!/\.adjustSold\(/.test(sweepSource));
  assert.ok(!/ariStore/.test(sweepSource));
  assert.ok(!/inventoryAdjuster/.test(sweepSource));
});

// ---------------------------------------------------------------------------
// 20-21: no event/queue/adapter/transport dependency, no network call
// ---------------------------------------------------------------------------

test('the tenant-bound ARI store factory introduces no network-capable call and no event/queue/adapter dependency', () => {
  const TENANT_STORE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'ari', 'store', 'tenantAriStore.js'), 'utf8');
  for (const src of [TENANT_STORE_SOURCE, ADJUSTER_SOURCE]) {
    assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(src));
    assert.ok(!/eventBus|channel_sync_queue_store|channelRegistry|adapter|transport/i.test(src));
  }
});

// ---------------------------------------------------------------------------
// 22: existing read contracts remain unchanged
// ---------------------------------------------------------------------------

test('static: read handlers (listRoomTypes/listRatePlans/getInventory/computeAri/quoteStay) still use the injected ariStore/ariService singleton, unchanged', () => {
  assert.match(HANDLERS_SOURCE, /async function listRoomTypes\(req, res\) \{[\s\S]*?ariStore\.roomTypes/);
  assert.match(HANDLERS_SOURCE, /async function listRatePlans\(req, res\) \{[\s\S]*?ariStore\.ratePlans/);
  assert.match(HANDLERS_SOURCE, /async function getInventory\(req, res\) \{[\s\S]*?ariStore\.inventory/);
  assert.match(HANDLERS_SOURCE, /async function computeAri\(req, res\) \{[\s\S]*?ariService\.computeAri/);
  assert.match(HANDLERS_SOURCE, /async function quoteStay\(req, res\) \{[\s\S]*?ariService\.quoteStay/);
});

// ---------------------------------------------------------------------------
// 23-24: no new .env access, no manual RLS bypass / SET SESSION duplication
// ---------------------------------------------------------------------------

test('static: no new file reads process.env or config/env, and none duplicates SET SESSION / BYPASSRLS / manual tenant binding', () => {
  const TENANT_STORE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'ari', 'store', 'tenantAriStore.js'), 'utf8');
  for (const src of [TENANT_STORE_SOURCE, ADJUSTER_SOURCE]) {
    assert.ok(!/process\.env/.test(src));
    assert.ok(!/require\(['"][^'"]*config\/env['"]\)/.test(src));
    assert.ok(!/BYPASSRLS/i.test(src));
    assert.ok(!/SET\s+SESSION/i.test(src));
    assert.ok(!/set_config\(/.test(src), 'tenant binding must be delegated to tenantUnitOfWork.js, never duplicated');
  }
});

// ---------------------------------------------------------------------------
// Read-side: withTenantAriRead exists and is READ ONLY
// ---------------------------------------------------------------------------

test('withTenantAriRead opens a READ ONLY unit of work (PostgreSQL itself rejects writes inside it)', async () => {
  const { pool, state } = makeFakePool({ boundTenantId: TENANT_A });
  let seenBeginText = null;
  const originalConnect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    client.query = async (text, params) => {
      if (/^BEGIN/i.test(String(text))) seenBeginText = String(text);
      return originalQuery(text, params);
    };
    return client;
  };

  await withTenantAriRead(pool, TENANT_A, (store) => store.inventory('p1', '2026-08-01', '2026-08-02'));
  assert.match(seenBeginText, /READ ONLY/i);
  assert.equal(state.connectCalls, 1);
});
