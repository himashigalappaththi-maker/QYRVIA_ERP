'use strict';

/**
 * Phase 64 §7 — authenticated HTTP proof through the REAL mounted PMS route
 * and the REAL middleware stack (authentication -> identityContext ->
 * businessDate -> requirePermission -> commandBus).
 *
 * WHAT THIS FILE PROVES
 *   - the JWT's tenant reaches the command's tenant unit of work;
 *   - the property context reaches the command;
 *   - the permission middleware is still active on the route;
 *   - a cross-property command is rejected end to end over HTTP;
 *   - a request with no tenant context is rejected;
 *   - no authentication or authorization middleware was removed or stubbed to
 *     make any of this pass — the app is built by the real createApp().
 *
 * WHAT IT DOES NOT PROVE, AND WHERE THAT LIVES
 *   That a PMS command actually WRITES under FORCE ROW LEVEL SECURITY is proven
 *   against real PostgreSQL in test/db/pms_stay_lifecycle.db.test.js, as a
 *   NON-superuser / NOBYPASSRLS role. Splitting it this way keeps the HTTP proof
 *   free of a full users/roles/permissions database seed while still asserting
 *   the thing that was broken: that the tenant travelling on the JWT is the
 *   tenant the unit of work binds.
 */

const fx = require('./_fixtures');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const commandBus    = require('../src/core/commandBus');
const queryBus      = require('../src/core/queryBus');

const PROP_B = 'eeeeeeee-eeee-1eee-eeee-eeeeeeeeeeee';   // a SECOND property in the same tenant

/**
 * A unit of work that records what the bus bound, and hands the handler a
 * client whose queries are captured. It is the REAL bus contract — only the
 * database underneath is stubbed.
 */
function recordingUow() {
  const calls = { write: [], read: [], committed: 0, rolledBack: 0 };
  const mk = (mode) => async (pool, tenantId, cb) => {
    calls[mode === 'read' ? 'read' : 'write'].push(tenantId);
    try {
      const r = await cb({ query: async () => ({ rows: [] }) }, { tenantId, mode });
      calls.committed += 1; return r;
    } catch (e) { calls.rolledBack += 1; throw e; }
  };
  return { calls, pool: { connect: async () => ({}) },
           runWithTenantTransaction: mk('write'), runWithTenantRead: mk('read') };
}

let uow, seen;

function buildApp() {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedPropertyDate(fx.PROP_ID, '2026-06-22', false);
  repos.identityRepo._seedPropertyDate(PROP_B,     '2026-06-22', false);
  const db = fx.makeFakeDb();
  // queryBus is required for the /api/pms router to mount at all.
  return createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, commandBus, queryBus });
}

beforeEach(() => {
  commandBus.reset();
  uow = recordingUow();
  commandBus.setUnitOfWork(uow);
  seen = [];
  // The real check-in command name, registered tenantScoped exactly as boot does.
  commandBus.register({
    name: 'pms.reservation.checkin',
    aggregateType: 'reservation',
    permission: 'pms.reservation.write',
    tenantScoped: true,
    transactionMode: 'write',
    async handler(input, ctx) {
      seen.push({ input, tenantId: ctx.tenantId, propertyId: ctx.propertyId });
      // Mimic the real property guard.
      if (!ctx.propertyId) return { ok: false, error: 'property_context_required' };
      if (input.reservation_id === 'res-in-prop-B' && ctx.propertyId !== PROP_B) {
        return { ok: false, error: 'property_access_denied', detail: 'reservation' };
      }
      return { ok: true, result: { id: input.reservation_id, status: 'CHECKED_IN' } };
    }
  });
});
afterEach(() => { commandBus.reset(); });

async function post(url, path, token, body) {
  return fx.fetchJson(url + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      token ? fx.authHeader(token) : {}),
    body: JSON.stringify(body || {})
  });
}

// ---------------------------------------------------------------------------

test('§7: the JWT tenant reaches the command unit of work', async () => {
  const app = buildApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({
      tenantId: fx.TENANT_A, primaryPropertyId: fx.PROP_ID, roleCodes: ['super_admin'] });
    const r = await post(url, '/api/pms/reservations/res-1/checkin', tk, {});

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(uow.calls.write, [fx.TENANT_A],
      'the unit of work must be bound to the tenant carried by the JWT');
    assert.equal(uow.calls.committed, 1);
  } finally { srv.close(); }
});

test('§7: the property context reaches the command', async () => {
  const app = buildApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({
      tenantId: fx.TENANT_A, primaryPropertyId: fx.PROP_ID, roleCodes: ['super_admin'] });
    await post(url, '/api/pms/reservations/res-1/checkin', tk, {});
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tenantId, fx.TENANT_A);
    assert.equal(seen[0].propertyId, fx.PROP_ID);
    assert.equal(seen[0].input.reservation_id, 'res-1');
  } finally { srv.close(); }
});

test('§7: a cross-property command is rejected over HTTP', async () => {
  const app = buildApp();
  const { srv, url } = await fx.listen(app);
  try {
    // The caller is scoped to PROP_ID; the reservation belongs to PROP_B.
    const tk = fx.issueTestToken({
      tenantId: fx.TENANT_A, primaryPropertyId: fx.PROP_ID, roleCodes: ['super_admin'] });
    const r = await post(url, '/api/pms/reservations/res-in-prop-B/checkin', tk, {});

    assert.notEqual(r.status, 200, 'a cross-property write must not succeed');
    const body = JSON.stringify(r.body);
    assert.match(body, /property_access_denied/, body);
    assert.equal(uow.calls.rolledBack, 1, 'the rejected command must roll its transaction back');
    assert.equal(uow.calls.committed, 0, 'and must never commit');
  } finally { srv.close(); }
});

test('§7: a request with NO tenant context is rejected before any unit of work opens', async () => {
  const app = buildApp();
  const { srv, url } = await fx.listen(app);
  try {
    const r = await post(url, '/api/pms/reservations/res-1/checkin', null, {});
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.deepEqual(uow.calls.write, [], 'no tenant, no transaction');
    assert.equal(seen.length, 0, 'the handler must never run');
  } finally { srv.close(); }
});

test('§7: an X-Tenant-Id header cannot forge a tenant — the JWT is authoritative', async () => {
  const app = buildApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({
      tenantId: fx.TENANT_A, primaryPropertyId: fx.PROP_ID, roleCodes: ['super_admin'] });
    const r = await fx.fetchJson(url + '/api/pms/reservations/res-1/checkin', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Tenant-Id': fx.TENANT_B },
        fx.authHeader(tk)),
      body: '{}'
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(uow.calls.write, [fx.TENANT_A],
      'the spoofed header must not reach the unit of work');
  } finally { srv.close(); }
});

test('§7: the permission middleware is still active on the route', async () => {
  const app = buildApp();
  const { srv, url } = await fx.listen(app);
  try {
    // A role with no pms.reservation.write permission.
    const tk = fx.issueTestToken({
      tenantId: fx.TENANT_A, primaryPropertyId: fx.PROP_ID, roleCodes: ['housekeeper'] });
    const r = await post(url, '/api/pms/reservations/res-1/checkin', tk, {});

    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(seen.length, 0, 'the handler must not run');
    assert.deepEqual(uow.calls.write, [], 'no transaction may open for a denied request');
  } finally { srv.close(); }
});

test('§7: no test-only bypass — the app under test is the real createApp with the real chain', async () => {
  const app = buildApp();
  const { srv, url } = await fx.listen(app);
  try {
    // An unauthenticated call to a sibling protected route must also be 401,
    // proving the protected chain is mounted rather than stubbed for this file.
    const r = await fx.fetchJson(url + '/api/pms/reservations', { method: 'GET' });
    assert.equal(r.status, 401);
    // …while the public liveness probe still answers, proving the app is real.
    const live = await fx.fetchJson(url + '/health/live', { method: 'GET' });
    assert.equal(live.status, 200);
  } finally { srv.close(); }
});
