'use strict';

/**
 * Phase 66A-B2N-C2 — STATIC contract test for collision-safe restriction-rule
 * outbox events. Reads source as TEXT; no database, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const OUTBOX   = read('ari/outbox/ariOutboxStore.js');
const HANDLERS = read('ari/api/ari.handlers.js');
const DB_STORE = read('ari/store/dbStore.js');
const MODIFIED = [OUTBOX, HANDLERS, DB_STORE];

function sliceFn(src, header, nextMarker) {
  const start = src.indexOf(header);
  assert.ok(start > -1, header + ' found');
  const rest = src.slice(start + header.length);
  const end = rest.indexOf(nextMarker);
  return header + (end > -1 ? rest.slice(0, end) : rest);
}

// ---- the v2 tuple ---------------------------------------------------------

test('the v2 key builder exists, is exported, and emits the aob:v2 prefix', () => {
  assert.match(OUTBOX, /function buildAriRestrictionDedupeKey\(\{ restrictionRuleId, level, roomTypeId, ratePlanId, channel, effectiveFrom, effectiveTo, sourceVersion \}\)/);
  assert.match(OUTBOX, /return 'aob:v2:' \+ crypto\.createHash\('sha256'\)\.update\(JSON\.stringify\(canonicalTuple\), 'utf8'\)\.digest\('hex'\)/);
  assert.match(OUTBOX, /module\.exports = \{[\s\S]*buildAriRestrictionDedupeKey,/);
});

test('the v2 canonical tuple is EXACTLY the eleven specified elements, in order', () => {
  const body = sliceFn(OUTBOX, 'function buildAriRestrictionDedupeKey(', '\n// Persisted ari_restriction_rule.level');
  const m = body.match(/const canonicalTuple = \[([\s\S]*?)\n  \];/);
  assert.ok(m, 'the canonical tuple literal is present');
  const elements = m[1].split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
  assert.deepEqual(elements, [
    'EVENT_TYPES.AVAILABILITY_CHANGED',
    'RESOURCE_KINDS.AVAILABILITY',
    "'RESTRICTION_RULE'",
    'restrictionRuleId',
    'level',
    'roomTypeId != null ? roomTypeId : null',
    'ratePlanId != null ? ratePlanId : null',
    'channel != null ? channel : null',
    'effectiveFrom',
    'effectiveTo',
    'sourceVersion'
  ]);
  assert.equal(elements.length, 11);
});

test('no payload, timestamp, request id, random UUID or tenant/property enters the v2 hash', () => {
  const body = sliceFn(OUTBOX, 'function buildAriRestrictionDedupeKey(', '\n// Persisted ari_restriction_rule.level');
  for (const forbidden of [/payload/, /Date\.now|new Date\(/, /requestId/, /randomUUID/, /tenantId/, /propertyId/]) {
    assert.ok(!forbidden.test(body), 'the hash must not contain ' + forbidden);
  }
});

test('the v1 builder and its 7-element tuple are UNCHANGED', () => {
  assert.match(OUTBOX, /function buildAriDedupeKey\(\{ eventType, resourceKind, roomTypeId, ratePlanId, effectiveFrom, effectiveTo, sourceVersion \}\)/);
  assert.match(OUTBOX, /return 'aob:v1:' \+ crypto\.createHash\('sha256'\)/);
  const v1 = sliceFn(OUTBOX, 'function buildAriDedupeKey(', '\n/**');
  const m = v1.match(/const canonicalTuple = \[([\s\S]*?)\n  \];/);
  const elements = m[1].split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
  assert.equal(elements.length, 7, 'v1 keeps exactly seven elements');
  assert.ok(!/RESTRICTION_RULE/.test(v1), 'v1 gains no discriminator');
});

test('the two validators are disjoint: a restrictionRuleId selects v2, everything else stays v1', () => {
  assert.match(OUTBOX, /const isRestriction = input && typeof input\.restrictionRuleId === 'string' && input\.restrictionRuleId\.length > 0/);
  assert.match(OUTBOX, /const v = isRestriction \? validateRestrictionEnqueueInput\(input\) : validateEnqueueInput\(input\)/);
  const rv = sliceFn(OUTBOX, 'function validateRestrictionEnqueueInput(', '\n/**');
  assert.match(rv, /must be AVAILABILITY_CHANGED/);
  assert.match(rv, /must carry resourceKind AVAILABILITY/);
  assert.match(rv, /does not match the canonical restriction identity/);
});

test('restriction_rule_id is written to the INSERT and is null for every v1 event', () => {
  assert.match(OUTBOX, /dedupe_key, payload_json, restriction_rule_id, status/);
  assert.match(OUTBOX, /const restrictionRuleId = isRestriction \? v\.restrictionRuleId : null/);
});

// ---- handler ---------------------------------------------------------------

const RESTRICTION_HANDLER = sliceFn(HANDLERS, '  async function upsertRestrictionRule(req, res)', '\n  // ---- ARI compute');

test('the B2N-C2 deferral marker is gone and the handler now enqueues', () => {
  assert.ok(!/PHASE 66A-B2N-C2 DEFERRAL/.test(HANDLERS), 'no deferral marker remains');
  assert.ok(!/deferred to B2N-C2/.test(RESTRICTION_HANDLER));
  assert.equal((RESTRICTION_HANDLER.match(/outbox\.enqueue\(/g) || []).length, 1);
});

test('the handler enqueues INSIDE the withTenantAriUnit callback, before it returns', () => {
  const unitAt    = RESTRICTION_HANDLER.indexOf('_withAriUnit(tenantId');
  const enqueueAt = RESTRICTION_HANDLER.indexOf('outbox.enqueue(');
  const returnAt  = RESTRICTION_HANDLER.indexOf('return saved;');
  assert.ok(unitAt > -1 && enqueueAt > unitAt, 'the enqueue is inside the unit');
  assert.ok(enqueueAt < returnAt, 'the enqueue precedes the callback return');
});

test('identity and payload use ONLY the persisted result — req.body scope is not used after persistence', () => {
  const afterSave = RESTRICTION_HANDLER.slice(RESTRICTION_HANDLER.indexOf('const saved = await fn.call'));
  for (const field of ['propertyId', 'level', 'roomTypeId', 'ratePlanId', 'channel', 'date_from', 'date_to', 'version', 'id']) {
    assert.ok(afterSave.includes('saved.' + field), 'uses saved.' + field);
  }
  assert.ok(!/rawBody\.|req\.body|body\./.test(afterSave), 'no request value is read after persistence');
});

test('the handler emits AVAILABILITY_CHANGED / AVAILABILITY with the rule id', () => {
  assert.match(RESTRICTION_HANDLER, /eventType:\s*'AVAILABILITY_CHANGED'/);
  assert.match(RESTRICTION_HANDLER, /resourceKind:\s*'AVAILABILITY'/);
  assert.match(RESTRICTION_HANDLER, /restrictionRuleId: saved\.id/);
  assert.match(RESTRICTION_HANDLER, /sourceVersion:\s*saved\.version/);
});

test('the handler resolves a property and fails closed before mutating', () => {
  const guardAt = RESTRICTION_HANDLER.indexOf('if (!property) throw propertyRequired();');
  const unitAt  = RESTRICTION_HANDLER.indexOf('_withAriUnit(tenantId');
  assert.ok(guardAt > -1 && guardAt < unitAt);
  assert.match(RESTRICTION_HANDLER, /const \{ tenantId, propertyId \} = tenantCtx\(req\)/);
});

test('no enqueue error is swallowed inside the restriction handler unit', () => {
  const unitBody = RESTRICTION_HANDLER.slice(RESTRICTION_HANDLER.indexOf('_withAriUnit(tenantId'), RESTRICTION_HANDLER.indexOf('return ok(res, row)'));
  assert.ok(!/catch\s*\(/.test(unitBody), 'no try/catch inside the unit — errors roll it back');
});

// ---- dbStore idempotency ---------------------------------------------------

const PUT_RESTRICTION = sliceFn(DB_STORE, '  async function putRestrictionRule(', '\n  /** Optimistic update');

test('the conflict path is guarded by a null-safe IS DISTINCT FROM over exactly the updated fields', () => {
  assert.match(PUT_RESTRICTION, /IS DISTINCT FROM/);
  const guard = PUT_RESTRICTION.slice(PUT_RESTRICTION.indexOf('WHERE ('), PUT_RESTRICTION.indexOf('RETURNING'));
  for (const f of ['cta', 'ctd', 'min_los', 'max_los', 'stay_through']) {
    assert.ok(guard.includes('ari_restriction_rule.' + f) && guard.includes('EXCLUDED.' + f));
  }
  for (const scope of ['room_type_id', 'rate_plan_id', 'date_from', 'date_to', 'level', 'channel', 'priority']) {
    assert.ok(!guard.includes('ari_restriction_rule.' + scope), scope + ' is not part of the no-op comparison');
  }
});

test('the complete persisted row is returned in ONE statement — no separate read, no request merge', () => {
  assert.match(PUT_RESTRICTION, /WITH upserted AS \(/);
  assert.match(PUT_RESTRICTION, /RETURNING \*/);
  assert.match(PUT_RESTRICTION, /UNION ALL/);
  assert.match(PUT_RESTRICTION, /NOT EXISTS \(SELECT 1 FROM upserted\)/);
  assert.equal((PUT_RESTRICTION.match(/await db\.query\(/g) || []).length, 1, 'exactly one query');
  assert.ok(!/Object\.assign\(\{\}, o, \{ version/.test(PUT_RESTRICTION),
    'the old request-model-plus-version return is gone');
  assert.match(PUT_RESTRICTION, /row\.version/);
  assert.match(PUT_RESTRICTION, /row\.room_type_id/);
});

test('the conflict clause still updates only the pre-existing five fields — scope semantics unchanged', () => {
  const setClause = PUT_RESTRICTION.slice(PUT_RESTRICTION.indexOf('DO UPDATE SET'), PUT_RESTRICTION.indexOf('WHERE ('));
  assert.match(setClause, /cta=EXCLUDED\.cta, ctd=EXCLUDED\.ctd, min_los=EXCLUDED\.min_los, max_los=EXCLUDED\.max_los, stay_through=EXCLUDED\.stay_through/);
  for (const scope of ['room_type_id=', 'rate_plan_id=', 'date_from=', 'date_to=', 'level=', 'channel=', 'priority=', 'dow=']) {
    assert.ok(!setClause.includes(scope), 'conflict must not update ' + scope);
  }
});

// ---- boundaries ------------------------------------------------------------

test('no placeholder room type or rate plan, and no payload hash, exists anywhere', () => {
  for (const src of MODIFIED) {
    assert.ok(!/PLACEHOLDER|__NONE__|SENTINEL_ROOM|'-'\s*\)/.test(src));
  }
  const rv = sliceFn(OUTBOX, 'function validateRestrictionEnqueueInput(', '\n/**');
  assert.ok(!/createHash[\s\S]{0,120}payload/.test(rv), 'payload is never hashed');
});

test('no bare pool, queue write, reservation_id, provider call or worker gate was introduced', () => {
  // Comments are stripped: the outbox header legitimately discusses future
  // TRANSPORT idempotency in prose. Only CODE is checked here.
  const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const src of MODIFIED.map(codeOnly)) {
    assert.ok(!/pool\.query\(|new Pool\(/.test(src));
    assert.ok(!/channel_sync_queue_store/.test(src));
    assert.ok(!/reservation_id|reservationId/.test(src));
    assert.ok(!/fetch\(|axios|http\.request|https\.request/i.test(src));
    assert.ok(!/CHANNEL_WORKER|DISPATCH_ENABLED|require\([^)]*adapter|require\([^)]*transport/i.test(src));
  }
});

test('the recursive secret-key rejection still guards the restriction path', () => {
  const rv = sliceFn(OUTBOX, 'function validateRestrictionEnqueueInput(', '\n/**');
  assert.match(rv, /assertNoSecretKeys\(body, ''\)/);
  assert.match(OUTBOX, /const SECRET_KEY_RE = \/\(password\|passwd\|secret\|token\|credential\|api\[_-\]\?key\|authorization\|private\[_-\]\?key\)\/i/);
});

test('no credential, URL or environment value was introduced into the modified sources', () => {
  for (const src of MODIFIED) {
    assert.ok(!/postgres(ql)?:\/\//i.test(src));
    assert.ok(!/process\.env/.test(src));
  }
});
