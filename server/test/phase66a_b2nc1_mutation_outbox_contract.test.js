'use strict';

/**
 * Phase 66A-B2N-C1 — STATIC contract test for atomic ARI mutation plus outbox
 * event production (inventory, room-type and rate-plan mutations).
 *
 * Reads the modified source files as TEXT and never executes a query — no
 * database connection, no network. Behavioural proofs (same client, one
 * BEGIN/COMMIT, rollback on enqueue failure, multi-night atomicity) live in
 * test/phase66a_b2nc1_mutation_outbox.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const DB_STORE   = read('ari/store/dbStore.js');
const TENANT_ARI = read('ari/store/tenantAriStore.js');
const ADJUSTER   = read('booking-engine/ariInventoryAdjuster.js');
const HANDLERS   = read('ari/api/ari.handlers.js');
const MODIFIED   = [DB_STORE, TENANT_ARI, ADJUSTER, HANDLERS];

// ---------------------------------------------------------------------------
// 1-3. Authoritative version is returned by the three config upserts (B2)
// ---------------------------------------------------------------------------

/** Slice a named function's body up to the start of the next declaration. */
function sliceFn(src, header, nextMarker) {
  const start = src.indexOf(header);
  assert.ok(start > -1, header + ' found');
  const rest = src.slice(start + header.length);
  const end = rest.indexOf(nextMarker);
  return header + (end > -1 ? rest.slice(0, end) : rest);
}

function upsertBody(name) {
  return sliceFn(DB_STORE, '  async function ' + name + '(', '\n  async function ');
}

test('1. dbStore putRoomType uses RETURNING version and surfaces it additively', () => {
  const body = upsertBody('putRoomType');
  assert.match(body, /RETURNING version/);
  assert.match(body, /Object\.assign\(\{\}, o, \{ version:/);
});

test('2. dbStore putRatePlan uses RETURNING version and surfaces it additively', () => {
  const body = upsertBody('putRatePlan');
  assert.match(body, /RETURNING version/);
  assert.match(body, /Object\.assign\(\{\}, o, \{ version:/);
});

test('3. dbStore putRestrictionRule uses RETURNING version and surfaces it additively', () => {
  const body = upsertBody('putRestrictionRule');
  assert.match(body, /RETURNING version/);
  assert.match(body, /Object\.assign\(\{\}, o, \{ version:/);
});

test('the version is taken only from the mutation statement — no extra SELECT, timestamp, counter or hash', () => {
  for (const name of ['putRoomType', 'putRatePlan', 'putRestrictionRule']) {
    const body = upsertBody(name);
    assert.ok(!/SELECT/i.test(body), name + ' must not perform a separate SELECT for the version');
    assert.ok(!/Date\.now|new Date\(|createHash/.test(body), name + ' must not derive a version');
  }
});

// ---------------------------------------------------------------------------
// 4-6. The combined tenant-bound unit
// ---------------------------------------------------------------------------

test('4. withTenantAriUnit calls runWithTenantTransaction exactly once', () => {
  assert.match(TENANT_ARI, /function withTenantAriUnit\(pool, tenantId, callback\)/);
  const start = TENANT_ARI.indexOf('function withTenantAriUnit(');
  const body = TENANT_ARI.slice(start, TENANT_ARI.indexOf('\n}', start));
  assert.equal((body.match(/runWithTenantTransaction\(/g) || []).length, 1);
});

test('5. the ARI store and the outbox store are built from the SAME transaction client', () => {
  assert.match(TENANT_ARI, /runWithTenantTransaction\(pool, tenantId, \(client\) =>\s*\n\s*callback\(\{\s*\n\s*ariStore: buildDbAriStore\(\{ db: client \}\),\s*\n\s*outbox:\s+buildAriOutboxStore\(\{ db: client \}\)/);
});

/** Source with block and line comments removed — for "no such CODE" checks. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('6. the combined helper opens no independent nested transaction and owns no COMMIT/ROLLBACK or tenant binding', () => {
  const code = codeOnly(TENANT_ARI);
  assert.ok(!/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i.test(code));
  assert.ok(!/set_config|SET SESSION|BYPASSRLS/i.test(code));
  assert.ok(!/pool\.query|pool\.connect/.test(code), 'no bare-pool path');
  // withTenantAriStore must delegate to the one unit, not open its own.
  assert.match(TENANT_ARI, /function withTenantAriStore\(pool, tenantId, callback\) \{\s*\n\s*return withTenantAriUnit\(/);
});

// ---------------------------------------------------------------------------
// 7-8. Adjuster emits inside the loop, never after the unit
// ---------------------------------------------------------------------------

test('7. ariInventoryAdjuster enqueues INSIDE the per-night loop, within the unit callback', () => {
  const unitStart = ADJUSTER.indexOf('await withAriStore(tenantId, async (ariStore) => {');
  assert.ok(unitStart > -1, 'the single unit of work is present');
  const unitEnd = ADJUSTER.indexOf('\n      });', unitStart);
  const unitBody = ADJUSTER.slice(unitStart, unitEnd);
  const loopStart = unitBody.indexOf('for (const date of dates) {');
  assert.ok(loopStart > -1, 'the night loop is inside the unit');
  const enqueueAt = unitBody.indexOf('outbox.enqueue(');
  assert.ok(enqueueAt > loopStart, 'the enqueue happens inside the night loop');
  assert.match(unitBody, /eventType:\s*'INVENTORY_CHANGED'/);
  assert.match(unitBody, /resourceKind:\s*'INVENTORY'/);
  assert.match(unitBody, /sourceVersion: result\.version/);
});

test('8. ariInventoryAdjuster does not enqueue after the unit callback returns, and never swallows an enqueue error', () => {
  const unitEnd = ADJUSTER.indexOf('\n      });', ADJUSTER.indexOf('await withAriStore(tenantId'));
  const after = ADJUSTER.slice(unitEnd);
  assert.ok(!/enqueue\(/.test(after), 'no enqueue after the transaction closes');
  assert.ok(!/catch\s*\(/.test(ADJUSTER), 'no try/catch anywhere — errors propagate and roll the unit back');
});

test('a floor/ceiling-guarded night emits no event and does not abort the unit', () => {
  assert.match(ADJUSTER, /if \(result === null\) \{[\s\S]*?continue;/);
});

test('the adjuster fails closed when propertyId is missing, before any mutation', () => {
  // Anchor on the real method (indented), not the header comment's example.
  const body = ADJUSTER.slice(ADJUSTER.indexOf('    async adjustSold({ tenantId'));
  const guardAt = body.indexOf('propertyId is required');
  const mutateAt = body.indexOf('await withAriStore(tenantId');
  assert.ok(guardAt > -1, 'the property guard exists');
  assert.ok(mutateAt > -1, 'the unit of work exists');
  assert.ok(guardAt < mutateAt, 'the property guard precedes the unit of work');
});

test('the adjuster still does not require from ari/ (the injected unit stays opaque)', () => {
  assert.ok(!/require\(['"][^'"]*\/ari\//.test(ADJUSTER));
});

// ---------------------------------------------------------------------------
// 9-12. Handler event mapping
// ---------------------------------------------------------------------------

function handlerBody(name) {
  return sliceFn(HANDLERS, '  async function ' + name + '(req, res)', '\n  async function ');
}

test('9. the inventory-cell handler emits exactly one INVENTORY_CHANGED and no second event', () => {
  const body = handlerBody('upsertInventoryCell');
  assert.equal((body.match(/outbox\.enqueue\(/g) || []).length, 1);
  assert.match(body, /eventType:\s*'INVENTORY_CHANGED'/);
  assert.match(body, /resourceKind:\s*'INVENTORY'/);
  // No SECOND event of any kind — the only eventType literal in the handler
  // is the single INVENTORY_CHANGED above (the prose comment explaining why
  // is not code).
  assert.deepEqual(body.match(/eventType:\s*'[A-Z_]+'/g), ["eventType:     'INVENTORY_CHANGED'"]);
  assert.ok(!/eventType:\s*'AVAILABILITY_CHANGED'/.test(body), 'no second AVAILABILITY_CHANGED for blocked/stopSell');
  assert.match(body, /sourceVersion: saved\.version/);
});

test('10. the room-type handler emits AVAILABILITY_CHANGED over the sentinel window', () => {
  const body = handlerBody('upsertRoomType');
  assert.equal((body.match(/outbox\.enqueue\(/g) || []).length, 1);
  assert.match(body, /eventType:\s*'AVAILABILITY_CHANGED'/);
  assert.match(body, /resourceKind:\s*'AVAILABILITY'/);
  assert.match(body, /effectiveFrom: ARI_CONFIG_EFFECTIVE_FROM/);
  assert.match(body, /effectiveTo:\s*ARI_CONFIG_EFFECTIVE_TO/);
  assert.match(body, /ratePlanId:\s*null/);
  assert.match(body, /sourceVersion: saved\.version/);
});

test('11. the rate-plan handler emits RATE_CHANGED and is the only handler carrying a ratePlanId', () => {
  const body = handlerBody('upsertRatePlan');
  assert.equal((body.match(/outbox\.enqueue\(/g) || []).length, 1);
  assert.match(body, /eventType:\s*'RATE_CHANGED'/);
  assert.match(body, /resourceKind:\s*'RATE'/);
  assert.match(body, /ratePlanId:\s*saved\.ratePlanId/);
  assert.match(body, /sourceVersion: saved\.version/);
  for (const other of ['upsertRoomType', 'upsertInventoryCell', 'adjustSold']) {
    assert.match(handlerBody(other), /ratePlanId:\s*null/, other + ' must pass a null ratePlanId');
  }
});

test('the single-cell adjustSold handler emits INVENTORY_CHANGED only when a row actually changed', () => {
  const body = handlerBody('adjustSold');
  assert.match(body, /if \(changed === null\) return null;/);
  const guardAt = body.indexOf('if (changed === null) return null;');
  const enqueueAt = body.indexOf('outbox.enqueue(');
  assert.ok(guardAt < enqueueAt, 'the zero-row guard precedes the enqueue');
  assert.match(body, /eventType:\s*'INVENTORY_CHANGED'/);
});

test('12. the restriction handler does NOT enqueue and carries the explicit B2N-C2 deferral marker', () => {
  const body = handlerBody('upsertRestrictionRule');
  assert.ok(!/enqueue\(/.test(body), 'restriction-rule event production is deferred');
  assert.match(HANDLERS, /PHASE 66A-B2N-C2 DEFERRAL/);
  assert.match(HANDLERS, /room_type_id and rate_plan_id are both NULLABLE/);
  assert.match(HANDLERS, /remain OPEN/);
});

test('every write handler resolves a property and fails closed before mutating', () => {
  for (const name of ['upsertRoomType', 'upsertRatePlan', 'upsertInventoryCell', 'adjustSold']) {
    const body = handlerBody(name);
    const guardAt = body.indexOf('if (!property) throw propertyRequired();');
    const unitAt = body.indexOf('_withAriUnit(');
    assert.ok(guardAt > -1, name + ' has the property guard');
    assert.ok(guardAt < unitAt, name + ' guards before opening the unit');
  }
});

test('write handlers derive tenant identity only from the trusted request context', () => {
  for (const name of ['upsertRoomType', 'upsertRatePlan', 'upsertInventoryCell', 'adjustSold', 'upsertRestrictionRule']) {
    const body = handlerBody(name);
    assert.match(body, /const \{ tenantId, propertyId \} = tenantCtx\(req\)/);
    assert.ok(!/tenant_id:\s*(rawBody|body)\.tenant_id/.test(body), name + ' must not trust a body tenant id');
  }
});

// ---------------------------------------------------------------------------
// 13-17. Boundaries
// ---------------------------------------------------------------------------

test('13. no modified source file references channel_sync_queue_store', () => {
  for (const src of MODIFIED) assert.ok(!/channel_sync_queue_store/.test(src));
});

test('14. no modified source file references reservation_id', () => {
  for (const src of MODIFIED) assert.ok(!/reservation_id|reservationId/.test(src));
});

test('15. no bare-pool ARI write was added', () => {
  for (const src of [TENANT_ARI, ADJUSTER, HANDLERS]) {
    assert.ok(!/pool\.query\(/.test(src), 'no direct pool.query');
    assert.ok(!/new Pool\(/.test(src), 'no pool construction');
  }
  // The handlers may only use `pool` to curry the approved unit helper.
  const poolUses = HANDLERS.match(/\bpool\b/g) || [];
  assert.ok(poolUses.length > 0);
  assert.match(HANDLERS, /pool \? \(tenantId, callback\) => withTenantAriUnit\(pool, tenantId, callback\) : null/);
});

test('16. no worker gate, provider call, adapter, transport or network capability was added', () => {
  for (const src of MODIFIED) {
    assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(src));
    assert.ok(!/adapter|transport|providerCall|CHANNEL_WORKER|DISPATCH_ENABLED/i.test(src));
  }
});

test('17. the undated configuration constants are exactly 1970-01-01 and 9999-12-31, defined once and never computed', () => {
  assert.match(TENANT_ARI, /const ARI_CONFIG_EFFECTIVE_FROM = '1970-01-01';/);
  assert.match(TENANT_ARI, /const ARI_CONFIG_EFFECTIVE_TO   = '9999-12-31';/);
  // Defined in exactly one module; the handlers import rather than redefine.
  assert.ok(!/ARI_CONFIG_EFFECTIVE_FROM\s*=/.test(HANDLERS), 'handlers must import, not redefine');
  assert.match(HANDLERS, /ARI_CONFIG_EFFECTIVE_FROM,\s*\n\s*ARI_CONFIG_EFFECTIVE_TO\s*\n\} = require\('\.\.\/store\/tenantAriStore'\)/);
});

test('no dedupeKey is constructed or overridden by hand anywhere', () => {
  for (const src of MODIFIED) {
    assert.ok(!/dedupeKey/.test(src), 'the canonical key is computed inside ariOutboxStore only');
  }
});

test('no credential, URL or environment value was introduced into the modified files', () => {
  for (const src of MODIFIED) {
    assert.ok(!/postgres(ql)?:\/\//i.test(src));
    assert.ok(!/process\.env/.test(src));
    assert.ok(!/password|api[_-]?key|authorization|bearer/i.test(src));
  }
});

test('no migration file was added for B2N-C1 and migration 0087 is untouched', () => {
  const migDir = path.join(SRC, 'db', 'migrations');
  const files = fs.readdirSync(migDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  assert.equal(files[files.length - 1], '0087_ari_outbox.sql', 'no migration newer than 0087');
  const mig = fs.readFileSync(path.join(migDir, '0087_ari_outbox.sql'), 'utf8');
  assert.match(mig, /CONSTRAINT uq_aob_logical_event\s*\n\s*UNIQUE \(tenant_id, property_id, dedupe_key\)/);
  assert.match(mig, /FOREIGN KEY \(tenant_id, property_id\)/);
});
