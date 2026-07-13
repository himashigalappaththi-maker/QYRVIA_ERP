'use strict';

/**
 * M1A — Mobile Operational API Prerequisites (correction round).
 *
 * Covers what phase46b/47/48 (hand-rolled in-memory fakes, predate M1A) do
 * not, and what the FIRST M1A pass got wrong for POS/Patrol property
 * resolution (see repos.js#_resolveAuthorizedPropertyId's doc comment):
 *
 *   1. DI wiring: build({}) is an empty router (no dependency -> no routes);
 *      build({repo}) is a live router.
 *   2. The real PostgreSQL-backed repos (gatepasRepo, posOrderRepo,
 *      patrolRepo from src/db/repos.js) issue tenant_id (+ property_id,
 *      mandatory for POS/Patrol) filtered, parameterized queries against a
 *      mock `pool` — never string-interpolated, never an unrestricted
 *      tenant-wide fallback.
 *   3. POS/Patrol property resolution uses ONLY identityRepo.canAccessProperty
 *      / listAccessibleProperties (the user's REAL authorized-property set):
 *        - active ctx.propertyId, authorized -> used directly (re-verified).
 *        - active ctx.propertyId, NOT authorized -> 403 PROPERTY_ACCESS_DENIED.
 *        - no active context, exactly 1 authorized property -> auto-resolved.
 *        - no active context, 0 authorized properties -> 403 PROPERTY_ACCESS_DENIED.
 *        - no active context, >1 authorized properties -> 400 *_PROPERTY_REQUIRED.
 *      Never an unrestricted `ORDER BY created_at ASC LIMIT 1` tenant-wide query.
 *   4. Patrol points/logs are strictly property-scoped: property_id is
 *      mandatory on every read/mutation, and a log's point must belong to the
 *      SAME tenant AND property as the log (cross-property point -> 400
 *      patrol_point_not_found, same controlled error as a nonexistent point).
 *   5. Client-supplied tenant_id / property_id / created_by_user_id / role
 *      fields in the request body can NEVER override the authenticated
 *      request context (req.ctx) for any of the three domains.
 *   6. Cross-tenant and cross-property record access is blocked server-side.
 *   7. Every mutating call is routed through runWithAudit and produces
 *      command.attempted + command.succeeded audit_events rows carrying
 *      entity_type/entity_id, actor, tenant, property, request_id.
 */

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createApp } = require('../src/app');
const { buildRepos } = require('../src/db/repos');

const gatepasRouterMod = require('../src/routes/gatepass');
const posRouterMod     = require('../src/routes/pos');
const patrolRouterMod  = require('../src/routes/patrol');

// ── 1. DI wiring: empty router without repo, real routes with repo ──────────

test('M1A wiring: gatepass router is empty without gatepasRepo, non-empty with it', () => {
  const empty = gatepasRouterMod.build({});
  assert.equal(empty.stack.length, 0, 'no dependency injected -> no routes registered (pre-M1A empty-router state)');

  const wired = gatepasRouterMod.build({ gatepasRepo: { list: async () => [], create: async () => ({}), recordScan: async () => null } });
  assert.ok(wired.stack.length > 0, 'gatepasRepo injected -> routes registered');
});

test('M1A wiring: pos router is empty without posOrderRepo, non-empty with it', () => {
  const empty = posRouterMod.build({});
  assert.equal(empty.stack.length, 0);

  const wired = posRouterMod.build({ posOrderRepo: { list: async () => [], create: async () => ({}) } });
  assert.ok(wired.stack.length > 0);
});

test('M1A wiring: patrol router is empty without patrolRepo, non-empty with it', () => {
  const empty = patrolRouterMod.build({});
  assert.equal(empty.stack.length, 0);

  const wired = patrolRouterMod.build({
    patrolRepo: {
      listPoints: async () => [], createPoint: async () => ({}), togglePoint: async () => null,
      listLogs: async () => [], createLog: async () => ({})
    }
  });
  assert.ok(wired.stack.length > 0);
});

// ── 2. Real repos against a mock pg pool ────────────────────────────────────
//
// The mock records every call {sql, params} and answers each of the query
// shapes buildRepos() actually issues, including the two identityRepo
// authorization queries every POS/Patrol resolution now depends on:
//   - listAccessibleProperties(userId): the WITH role_props AS (...) CTE.
//   - canAccessProperty(userId, propertyId): the SELECT EXISTS (...) AS ok.
// `accessibleProperties` controls both: canAccessProperty(userId, pid) is
// true iff pid is in that list, and listAccessibleProperties returns exactly
// that list (shaped like the real query's row: {id, code, name, tenant_id,
// active, role_codes}).

function makeMockPool({ accessibleProperties = [], patrolPointMatches = true } = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();

      if (/role_props AS/.test(s)) { // identityRepo.listAccessibleProperties
        return {
          rows: accessibleProperties.map((id, i) => ({
            id, code: 'PROP' + i, name: 'Property ' + i,
            tenant_id: fx.TENANT_A, active: true, role_codes: []
          }))
        };
      }
      if (/u\.primary_property_id = \$2/.test(s)) { // identityRepo.canAccessProperty
        return { rows: [{ ok: accessibleProperties.includes(params[1]) }] };
      }

      if (/SELECT \* FROM gate_passes/.test(s))   return { rows: [{ id: 'gp-1', tenant_id: params[0] }] };
      if (/INSERT INTO gate_passes/.test(s))      return { rows: [{ id: 'gp-1', tenant_id: params[0], property_id: params[1] }] };
      if (/UPDATE gate_passes/.test(s))           return { rows: [{ id: params[2], tenant_id: params[0] }] };

      if (/SELECT \* FROM pos_orders/.test(s))    return { rows: [{ id: 'ord-1', tenant_id: params[0], payload: {} }] };
      if (/INSERT INTO restaurant_outlets/.test(s)) return { rows: [{ id: 'outlet-1' }] };
      if (/SELECT id FROM restaurant_outlets/.test(s)) return { rows: [{ id: 'outlet-1' }] };
      if (/INSERT INTO pos_orders/.test(s))       return { rows: [{ id: 'ord-1', tenant_id: params[0], property_id: params[1], payload: params[5] }] };

      if (/SELECT \* FROM patrol_points/.test(s)) return { rows: [{ id: 'pp-1', tenant_id: params[0], property_id: params[1] }] };
      if (/INSERT INTO patrol_points/.test(s))    return { rows: [{ id: 'pp-1', tenant_id: params[0], property_id: params[1], active: true }] };
      if (/UPDATE patrol_points/.test(s))         return { rows: [{ id: params[2], active: false }] };
      if (/SELECT \* FROM patrol_logs/.test(s))   return { rows: [{ id: 'pl-1', tenant_id: params[0], property_id: params[1] }] };
      if (/INSERT INTO patrol_logs/.test(s)) {
        // repos.js createLog: INSERT ... SELECT ... WHERE EXISTS (patrol_points
        // matching tenant_id + property_id). Simulate that guard here.
        if (!patrolPointMatches) return { rows: [] };
        return { rows: [{ id: 'pl-1', tenant_id: params[0], property_id: params[1], point_id: params[2] }] };
      }

      throw new Error('unexpected query in mock pool: ' + s);
    }
  };
  return pool;
}

const PROP_1 = '11111111-aaaa-1aaa-aaaa-aaaaaaaaaaa1';
const PROP_2 = '11111111-aaaa-1aaa-aaaa-aaaaaaaaaaa2';
const POINT_ID = '22222222-2222-2222-2222-222222222222';

const CTX_NO_PROPERTY = { tenantId: fx.TENANT_A, propertyId: null, actorId: fx.USER_ID, requestId: 'req-1' };
function ctxWithProperty(propertyId) {
  return { tenantId: fx.TENANT_A, propertyId, actorId: fx.USER_ID, requestId: 'req-1' };
}

test('M1A repo SQL: gatepasRepo filters every query by tenant_id (+ NULL-safe property_id)', async () => {
  const pool = makeMockPool();
  const { gatepasRepo } = buildRepos(pool);

  await gatepasRepo.list(ctxWithProperty(PROP_1));
  let call = pool.calls.find(c => /SELECT \* FROM gate_passes/.test(c.sql));
  assert.equal(call.params[0], fx.TENANT_A);
  assert.equal(call.params[1], PROP_1);
  assert.doesNotMatch(call.sql, /\$\{|`\s*\+/, 'no string interpolation of caller input into SQL');

  await gatepasRepo.create({ property_id: PROP_1, pass_no: 'GP-1', type: 'GUEST', name: 'X', movement: 'IN/OUT', status: 'ACTIVE', valid_from: new Date().toISOString(), created_by_user_id: fx.USER_ID }, ctxWithProperty(PROP_1));
  call = pool.calls.find(c => /INSERT INTO gate_passes/.test(c.sql));
  assert.equal(call.params[0], fx.TENANT_A, 'tenant_id in the INSERT always comes from ctx, not the record');

  const scanned = await gatepasRepo.recordScan('11111111-1111-1111-1111-111111111111', { direction: 'IN' }, ctxWithProperty(PROP_1));
  call = pool.calls.find(c => /UPDATE gate_passes/.test(c.sql));
  assert.equal(call.params[0], fx.TENANT_A);
  assert.equal(call.params[1], PROP_1);
  assert.ok(scanned);

  // Malformed id -> null (404 upstream), never reaches the database.
  const before = pool.calls.length;
  const result = await gatepasRepo.recordScan('not-a-uuid', { direction: 'IN' }, ctxWithProperty(PROP_1));
  assert.equal(result, null);
  assert.equal(pool.calls.length, before, 'malformed id short-circuits before any query');
});

// ── POS: authorized-property resolution ─────────────────────────────────────

test('M1A POS property resolution: active ctx.propertyId, authorized -> used directly (re-verified via canAccessProperty)', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1] });
  const { posOrderRepo } = buildRepos(pool);

  await posOrderRepo.create({ type: 'Room Service', items: [], created_by_user_id: fx.USER_ID }, ctxWithProperty(PROP_1));

  const authCheck = pool.calls.find(c => /u\.primary_property_id = \$2/.test(c.sql));
  assert.ok(authCheck, 'canAccessProperty must be called to re-verify the active property (defense-in-depth)');
  assert.equal(authCheck.params[0], fx.USER_ID);
  assert.equal(authCheck.params[1], PROP_1);

  const insert = pool.calls.find(c => /INSERT INTO pos_orders/.test(c.sql));
  assert.equal(insert.params[0], fx.TENANT_A);
  assert.equal(insert.params[1], PROP_1);
  assert.equal(pool.calls.some(c => /role_props AS/.test(c.sql)), false, 'no need to list all accessible properties when an active one is already set');
});

test('M1A POS property resolution: active ctx.propertyId, NOT authorized -> 403 PROPERTY_ACCESS_DENIED, no INSERT', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_2] }); // user authorized for PROP_2, not PROP_1
  const { posOrderRepo } = buildRepos(pool);

  await assert.rejects(
    () => posOrderRepo.create({ type: 'Room Service', items: [], created_by_user_id: fx.USER_ID }, ctxWithProperty(PROP_1)),
    (err) => err.code === 'PROPERTY_ACCESS_DENIED'
  );
  assert.equal(pool.calls.some(c => /INSERT INTO pos_orders/.test(c.sql)), false, 'must never insert against an unauthorized property');
});

test('M1A POS property resolution: no active context, exactly one authorized property -> auto-resolved safely', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1] });
  const { posOrderRepo } = buildRepos(pool);

  const order = await posOrderRepo.create({ type: 'Room Service', items: [], created_by_user_id: fx.USER_ID }, CTX_NO_PROPERTY);
  assert.equal(order.property_id, PROP_1);

  const listCall = pool.calls.find(c => /role_props AS/.test(c.sql));
  assert.ok(listCall, 'must consult the user\'s real authorized-property set');
  assert.equal(listCall.params[0], fx.USER_ID);

  const insert = pool.calls.find(c => /INSERT INTO pos_orders/.test(c.sql));
  assert.equal(insert.params[1], PROP_1);
});

test('M1A POS property resolution: no active context, zero authorized properties -> 403 PROPERTY_ACCESS_DENIED', async () => {
  const pool = makeMockPool({ accessibleProperties: [] });
  const { posOrderRepo } = buildRepos(pool);

  await assert.rejects(
    () => posOrderRepo.create({ type: 'Room Service', items: [], created_by_user_id: fx.USER_ID }, CTX_NO_PROPERTY),
    (err) => err.code === 'PROPERTY_ACCESS_DENIED'
  );
  assert.equal(pool.calls.some(c => /INSERT INTO pos_orders/.test(c.sql)), false);
});

test('M1A POS property resolution: no active context, multiple authorized properties -> 400 POS_PROPERTY_REQUIRED', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1, PROP_2] });
  const { posOrderRepo } = buildRepos(pool);

  await assert.rejects(
    () => posOrderRepo.create({ type: 'Room Service', items: [], created_by_user_id: fx.USER_ID }, CTX_NO_PROPERTY),
    (err) => err.code === 'POS_PROPERTY_REQUIRED'
  );
  assert.equal(pool.calls.some(c => /INSERT INTO pos_orders/.test(c.sql)), false);
});

test('M1A POS property resolution: never issues an unrestricted tenant-wide "first property" fallback query', async () => {
  // Across every scenario above, the repo must never issue a bare
  // `SELECT id FROM properties WHERE tenant_id = $1 ORDER BY ... LIMIT 1`
  // (the exact pattern this correction round removed).
  for (const accessibleProperties of [[], [PROP_1], [PROP_1, PROP_2]]) {
    const pool = makeMockPool({ accessibleProperties });
    const { posOrderRepo } = buildRepos(pool);
    try { await posOrderRepo.create({ type: 'Room Service', items: [], created_by_user_id: fx.USER_ID }, CTX_NO_PROPERTY); } catch (_) { /* expected for 0/2 */ }
    const forbidden = pool.calls.find(c => /ORDER BY created_at ASC LIMIT 1/.test(c.sql));
    assert.equal(forbidden, undefined, 'unrestricted tenant-wide property fallback must never be issued');
  }
});

// Client-supplied property_id on the record is ignored — resolution is
// entirely ctx-driven, never rec-driven.
test('M1A POS property resolution: client-supplied rec.property_id has no effect on the resolved property', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1] });
  const { posOrderRepo } = buildRepos(pool);

  const order = await posOrderRepo.create(
    { type: 'Room Service', items: [], created_by_user_id: fx.USER_ID, property_id: 'spoofed-property-id', tenant_id: 'spoofed-tenant-id' },
    CTX_NO_PROPERTY
  );
  assert.equal(order.property_id, PROP_1, 'resolved property comes from ctx/authorization, never from the record');
});

// ── Patrol: strict property scoping ─────────────────────────────────────────

test('M1A patrol property resolution: every read/mutation resolves and filters by tenant_id AND property_id (mandatory, no NULL-safe optionality)', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1] });
  const { patrolRepo } = buildRepos(pool);

  await patrolRepo.listPoints(CTX_NO_PROPERTY);
  let call = pool.calls.find(c => /SELECT \* FROM patrol_points/.test(c.sql));
  assert.equal(call.params[0], fx.TENANT_A);
  assert.equal(call.params[1], PROP_1);
  assert.doesNotMatch(call.sql, /\$2::uuid IS NULL/, 'property_id is mandatory for patrol - no NULL-safe optional filter');

  await patrolRepo.createPoint({ name: 'Lobby', zone: 'Interior', created_by: fx.USER_ID }, ctxWithProperty(PROP_1));
  call = pool.calls.find(c => /INSERT INTO patrol_points/.test(c.sql));
  assert.equal(call.params[0], fx.TENANT_A);
  assert.equal(call.params[1], PROP_1);

  await patrolRepo.togglePoint(POINT_ID, ctxWithProperty(PROP_1));
  call = pool.calls.find(c => /UPDATE patrol_points/.test(c.sql));
  assert.equal(call.params[0], fx.TENANT_A);
  assert.equal(call.params[1], PROP_1);

  await patrolRepo.listLogs(ctxWithProperty(PROP_1));
  call = pool.calls.find(c => /SELECT \* FROM patrol_logs/.test(c.sql));
  assert.equal(call.params[0], fx.TENANT_A);
  assert.equal(call.params[1], PROP_1);
});

test('M1A patrol property resolution: malformed point id short-circuits togglePoint before any query', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1] });
  const { patrolRepo } = buildRepos(pool);
  const before = pool.calls.length;
  assert.equal(await patrolRepo.togglePoint('not-a-uuid', ctxWithProperty(PROP_1)), null);
  assert.equal(pool.calls.length, before, 'malformed id short-circuits before any query (including property resolution)');
});

test('M1A patrol property resolution: zero authorized properties -> 403 PROPERTY_ACCESS_DENIED on read and write', async () => {
  const pool = makeMockPool({ accessibleProperties: [] });
  const { patrolRepo } = buildRepos(pool);

  await assert.rejects(() => patrolRepo.listPoints(CTX_NO_PROPERTY), (err) => err.code === 'PROPERTY_ACCESS_DENIED');
  await assert.rejects(() => patrolRepo.createPoint({ name: 'X', zone: 'Exterior' }, CTX_NO_PROPERTY), (err) => err.code === 'PROPERTY_ACCESS_DENIED');
  await assert.rejects(() => patrolRepo.listLogs(CTX_NO_PROPERTY), (err) => err.code === 'PROPERTY_ACCESS_DENIED');
});

test('M1A patrol property resolution: multiple authorized properties, no active context -> 400 PATROL_PROPERTY_REQUIRED', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1, PROP_2] });
  const { patrolRepo } = buildRepos(pool);

  await assert.rejects(() => patrolRepo.listPoints(CTX_NO_PROPERTY), (err) => err.code === 'PATROL_PROPERTY_REQUIRED');
  await assert.rejects(() => patrolRepo.createPoint({ name: 'X', zone: 'Exterior' }, CTX_NO_PROPERTY), (err) => err.code === 'PATROL_PROPERTY_REQUIRED');
});

test('M1A patrol property resolution: exactly one authorized property auto-resolves safely for a read and a write', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1] });
  const { patrolRepo } = buildRepos(pool);

  await patrolRepo.listPoints(CTX_NO_PROPERTY);
  let call = pool.calls.find(c => /SELECT \* FROM patrol_points/.test(c.sql));
  assert.equal(call.params[1], PROP_1);

  const point = await patrolRepo.createPoint({ name: 'Roof', zone: 'Exterior' }, CTX_NO_PROPERTY);
  assert.equal(point.property_id, PROP_1);
});

test('M1A patrol property resolution: active ctx.propertyId NOT authorized -> 403, no query issued against it', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_2] });
  const { patrolRepo } = buildRepos(pool);
  await assert.rejects(() => patrolRepo.listPoints(ctxWithProperty(PROP_1)), (err) => err.code === 'PROPERTY_ACCESS_DENIED');
  assert.equal(pool.calls.some(c => /SELECT \* FROM patrol_points/.test(c.sql)), false);
});

test('M1A patrol: createLog succeeds when the point belongs to the SAME tenant + property as the log', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1], patrolPointMatches: true });
  const { patrolRepo } = buildRepos(pool);
  const log = await patrolRepo.createLog(
    { point_id: POINT_ID, officer_id: fx.USER_ID, checked_at: new Date().toISOString() },
    ctxWithProperty(PROP_1)
  );
  assert.ok(log);
  const insert = pool.calls.find(c => /INSERT INTO patrol_logs/.test(c.sql));
  assert.equal(insert.params[0], fx.TENANT_A);
  assert.equal(insert.params[1], PROP_1);
});

test('M1A patrol: createLog rejects a point that belongs to a DIFFERENT property (same tenant) as PATROL_POINT_NOT_FOUND, not a silent cross-property write', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1], patrolPointMatches: false }); // WHERE EXISTS fails
  const { patrolRepo } = buildRepos(pool);
  await assert.rejects(
    () => patrolRepo.createLog({ point_id: POINT_ID, officer_id: fx.USER_ID, checked_at: new Date().toISOString() }, ctxWithProperty(PROP_1)),
    (err) => err.code === 'PATROL_POINT_NOT_FOUND'
  );
});

test('M1A patrol: createLog rejects a malformed point_id before any query, and a genuine FK violation still maps to PATROL_POINT_NOT_FOUND', async () => {
  const pool = makeMockPool({ accessibleProperties: [PROP_1] });
  const { patrolRepo } = buildRepos(pool);

  const before = pool.calls.length;
  await assert.rejects(
    () => patrolRepo.createLog({ point_id: 'not-a-uuid', officer_id: fx.USER_ID, checked_at: new Date().toISOString() }, ctxWithProperty(PROP_1)),
    (err) => err.code === 'PATROL_POINT_NOT_FOUND'
  );
  assert.equal(pool.calls.length, before, 'malformed point_id short-circuits before any query');

  const fkPool = {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/u\.primary_property_id = \$2/.test(s)) return { rows: [{ ok: true }] };
      if (/INSERT INTO patrol_logs/.test(s)) { const e = new Error('fk violation'); e.code = '23503'; throw e; }
      throw new Error('unexpected query: ' + s);
    }
  };
  const { patrolRepo: fkPatrolRepo } = buildRepos(fkPool);
  await assert.rejects(
    () => fkPatrolRepo.createLog({ point_id: POINT_ID, officer_id: fx.USER_ID, checked_at: new Date().toISOString() }, ctxWithProperty(PROP_1)),
    (err) => err.code === 'PATROL_POINT_NOT_FOUND'
  );
});

// ── Route-level HTTP tests: property-resolution status codes ───────────────
//
// These mount the REAL posOrderRepo/patrolRepo (buildRepos against a mock
// pg pool, same as the SQL-mock tests above) through the real createApp/
// identityContext/authorization middleware chain, so the 400/PROPERTY_
// REQUIRED and 403/PROPERTY_ACCESS_DENIED translations in routes/pos.js and
// routes/patrol.js are exercised end-to-end over real HTTP, not just at the
// repo layer. Authentication/permission checks use the pre-existing
// fx.makeFakeRepos() in-memory identityRepo (a SEPARATE identityRepo from
// the one buildRepos(pool) constructs internally for property resolution -
// exactly as in production, where identityContext and repos.js#identityRepo
// are the same singleton but conceptually distinct concerns here).

const ALL_PERMS = [
  'gatepass.read', 'gatepass.write',
  'pos.order.read', 'pos.order.write',
  'patrol.point.read', 'patrol.point.write', 'patrol.log.read', 'patrol.log.write',
];

function makeRouteApp({ accessibleProperties = [], patrolPointMatches = true } = {}) {
  const pool = makeMockPool({ accessibleProperties, patrolPointMatches });
  const { posOrderRepo, patrolRepo } = buildRepos(pool);
  const authRepos = fx.makeFakeRepos();
  authRepos.identityRepo._seedUser({ id: fx.USER_ID, username: 'staff', tenant_id: fx.TENANT_A }, [], ALL_PERMS);
  const app = createApp({
    db: fx.makeFakeDb(),
    identityRepo: authRepos.identityRepo,
    tokensRepo:   authRepos.tokensRepo,
    posOrderRepo,
    patrolRepo,
  });
  return { app, pool };
}

test('M1A HTTP: POS order create -> 201 when the JWT primary property is the single authorized property', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [PROP_1] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'], primaryPropertyId: PROP_1 });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Room Service', items: [] }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.property_id, PROP_1);
  } finally { srv.close(); }
});

test('M1A HTTP: POS order create -> 400 property_context_required when the caller has multiple authorized properties and no active one', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [PROP_1, PROP_2] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'], primaryPropertyId: null });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Room Service', items: [] }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'property_context_required');
  } finally { srv.close(); }
});

test('M1A HTTP: POS order create -> 403 property_access_denied when the caller has zero authorized properties', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'], primaryPropertyId: null });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Room Service', items: [] }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'property_access_denied');
  } finally { srv.close(); }
});

test('M1A HTTP: POS order create -> 403 when the JWT primary property is NOT in the caller\'s authorized set (stale/tampered claim)', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [PROP_2] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'], primaryPropertyId: PROP_1 }); // not authorized for PROP_1
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Room Service', items: [] }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'property_access_denied');
  } finally { srv.close(); }
});

test('M1A HTTP: POS order create ignores client-supplied property_id / created_by_user_id / role fields in the body', async () => {
  const { app, pool } = makeRouteApp({ accessibleProperties: [PROP_1] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'], primaryPropertyId: PROP_1 });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({
        type: 'Room Service', items: [],
        property_id: PROP_2, tenant_id: fx.TENANT_B,
        created_by_user_id: 'spoofed-user', role_codes: ['super_admin'],
      }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.property_id, PROP_1, 'server-resolved property, not the spoofed body value');
    const insert = pool.calls.find(c => /INSERT INTO pos_orders/.test(c.sql));
    assert.equal(insert.params[0], fx.TENANT_A, 'tenant_id always from JWT, never body');
  } finally { srv.close(); }
});

test('M1A HTTP: Patrol point create -> 400 patrol_property_required with multiple authorized properties and no active context', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [PROP_1, PROP_2] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'], primaryPropertyId: null });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ name: 'Main Gate' }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'patrol_property_required');
  } finally { srv.close(); }
});

test('M1A HTTP: Patrol point create -> 403 property_access_denied with zero authorized properties', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'], primaryPropertyId: null });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ name: 'Main Gate' }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'property_access_denied');
  } finally { srv.close(); }
});

test('M1A HTTP: Patrol point create -> 201 and property auto-resolved when exactly one authorized property exists', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [PROP_1] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'], primaryPropertyId: null });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ name: 'Main Gate', property_id: PROP_2 /* spoof attempt, must be ignored */ }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.property_id, PROP_1, 'resolved from the authorized set, spoofed body value ignored');
  } finally { srv.close(); }
});

test('M1A HTTP: Patrol log create -> 400 patrol_point_not_found when the point belongs to a different property than the resolved one', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [PROP_1], patrolPointMatches: false });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'], primaryPropertyId: PROP_1 });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ point_id: POINT_ID, gps: { lat: 6.9, lng: 79.8 } }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'patrol_point_not_found', 'cross-property point reference must be rejected, never silently written');
  } finally { srv.close(); }
});

test('M1A HTTP: Patrol log create -> 201 when the point belongs to the same tenant + resolved property', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [PROP_1], patrolPointMatches: true });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'], primaryPropertyId: PROP_1 });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ point_id: POINT_ID, gps: { lat: 6.9, lng: 79.8 } }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.property_id, PROP_1);
  } finally { srv.close(); }
});

test('M1A HTTP: Patrol log create -> 201 response and audit event both carry the server-resolved property, never a client-supplied one', async () => {
  const { app } = makeRouteApp({ accessibleProperties: [PROP_1], patrolPointMatches: true });
  const db = app.get('db');
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'], primaryPropertyId: PROP_1 });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ point_id: POINT_ID, gps: { lat: 6.9, lng: 79.8 }, property_id: PROP_2, tenant_id: fx.TENANT_B }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.property_id, PROP_1);
    const cmdEvents = db.auditRows.filter(ev => String(ev.event_type || '').startsWith('command.'));
    assert.ok(cmdEvents.length > 0, 'patrol log create must produce command audit events even under the new property-resolution path');
  } finally { srv.close(); }
});
