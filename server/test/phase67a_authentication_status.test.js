'use strict';

/**
 * Phase 67A-003 Workstreams B + C — middleware/authentication.js contract
 * tests (rewritten from the prior Phase 67A pass to match the corrected
 * ACTIVE-only, fail-closed behaviour):
 *
 *   - Workstream B: ONLY status === 'ACTIVE' is allowed (positive rule),
 *     not a DISABLED/TERMINATED blacklist. LOCKED, PENDING_PASSWORD_RESET,
 *     null, and unknown/future statuses are all rejected too.
 *   - Workstream C: the old "no status repo wired -> JWT-only fallback"
 *     behaviour has been REMOVED. No repo wired == fail closed (401),
 *     exactly like a repo error. There is no fallback test in this file
 *     because the fallback no longer exists.
 *
 * Pure unit tests calling authentication(req, res, next) /
 * optionalAuthentication(req, res, next) directly with fake req/res
 * objects and a real signed JWT (via services/tokens.js). No HTTP server,
 * no PostgreSQL connection.
 *
 * TEST ISOLATION: this file calls setStatusRepo directly (not only via
 * routes/auth.js's build()), so every test explicitly wires the repo it
 * needs and afterEach resets the singleton to null — no test in this file
 * (or after it, in another node:test worker) can observe a repo left over
 * from a previous test.
 */

const fx = require('./_fixtures'); // sets JWT_SECRET/DATABASE_URL/etc before tokens.js loads
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const tokens = require('../src/services/tokens');
const { authentication, optionalAuthentication, setStatusRepo } = require('../src/middleware/authentication');

const TENANT_A = fx.TENANT_A;
const USER_ID  = fx.USER_ID;

function makeReq(token) {
  return {
    get(name) {
      if (String(name).toLowerCase() === 'authorization') return token ? `Bearer ${token}` : undefined;
      return undefined;
    }
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

function issueToken(overrides) {
  const t = tokens.issueAccessToken(Object.assign({
    userId: USER_ID, tenantId: TENANT_A, primaryPropertyId: null,
    roleCodes: ['corporate_admin'], roleIds: []
  }, overrides));
  return t.token;
}

function makeStatusRepo() {
  const users = new Map();
  return {
    _seedUser(u) { users.set(u.id, u); },
    async withTenant(tenantId, cb) { return cb({ tenantId }); },
    async findUserById(id, client) {
      const u = users.get(id);
      if (!u) return null;
      // Tenant-scoped by construction, mirroring FORCE RLS.
      if (u.tenant_id !== client.tenantId) return null;
      return u;
    }
  };
}

afterEach(() => { setStatusRepo(null); });

async function runAuthentication(token) {
  const req = makeReq(token); const res = makeRes();
  let nextCalled = false;
  await authentication(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

// ── No / invalid token ───────────────────────────────────────────────────────

test('authentication: missing bearer -> 401 authentication_required', async () => {
  const { res, nextCalled } = await runAuthentication(null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'authentication_required');
  assert.equal(nextCalled, false);
});

test('authentication: garbage token -> 401 invalid_or_expired_token', async () => {
  const { res, nextCalled } = await runAuthentication('not-a-real-jwt');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'invalid_or_expired_token');
  assert.equal(nextCalled, false);
});

// ── Workstream C: no fallback — missing repo fails closed ──────────────────

test('authentication: NO STATUS REPO WIRED -> fails closed with 401 (no JWT-only fallback exists anymore)', async () => {
  setStatusRepo(null);
  const token = issueToken();
  const { res, nextCalled } = await runAuthentication(token);
  assert.equal(nextCalled, false, 'a structurally valid JWT must NOT be enough on its own');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'authentication_required');
});

test('authentication: an unexpected repo error fails closed (401)', async () => {
  setStatusRepo({
    async withTenant() { throw new Error('boom'); },
    async findUserById() { return null; }
  });
  const token = issueToken();
  const { res, nextCalled } = await runAuthentication(token);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'authentication_required');
});

// ── Workstream B: positive ACTIVE-only allow rule ───────────────────────────

test('authentication: ACTIVE user with a valid token succeeds', async () => {
  const repo = makeStatusRepo();
  repo._seedUser({ id: USER_ID, tenant_id: TENANT_A, status: 'ACTIVE' });
  setStatusRepo(repo);
  const { res, req, nextCalled } = await runAuthentication(issueToken());
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal(req.user.sub, USER_ID);
});

const REJECTED_STATUSES = ['DISABLED', 'TERMINATED', 'LOCKED', 'PENDING_PASSWORD_RESET', 'SOME_FUTURE_STATUS', null, ''];

for (const status of REJECTED_STATUSES) {
  test(`authentication: status ${JSON.stringify(status)} is rejected (only ACTIVE is allowed)`, async () => {
    const repo = makeStatusRepo();
    repo._seedUser({ id: USER_ID, tenant_id: TENANT_A, status });
    setStatusRepo(repo);
    const { res, nextCalled } = await runAuthentication(issueToken());
    assert.equal(nextCalled, false, `status ${status} must be rejected`);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'account_not_active');
  });
}

test('authentication: a missing/soft-deleted user (findUserById -> null) is rejected', async () => {
  const repo = makeStatusRepo(); // no user seeded == "missing"
  setStatusRepo(repo);
  const { res, nextCalled } = await runAuthentication(issueToken());
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'account_not_active');
});

test('authentication: a token claiming a tenant the user is not actually in is rejected', async () => {
  const repo = makeStatusRepo();
  repo._seedUser({ id: USER_ID, tenant_id: 'some-other-tenant-id', status: 'ACTIVE' });
  setStatusRepo(repo);
  const { res, nextCalled } = await runAuthentication(issueToken({ tenantId: TENANT_A }));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'account_not_active');
});

// ── optionalAuthentication ───────────────────────────────────────────────────

test('optionalAuthentication: no token supplied -> continues anonymously', () => {
  const req = makeReq(null); const res = makeRes();
  let nextCalled = false;
  optionalAuthentication(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user, undefined);
  assert.equal(res.statusCode, null);
});

test('optionalAuthentication: a supplied token for an ACTIVE user succeeds and attaches req.user', async () => {
  const repo = makeStatusRepo();
  repo._seedUser({ id: USER_ID, tenant_id: TENANT_A, status: 'ACTIVE' });
  setStatusRepo(repo);
  const req = makeReq(issueToken()); const res = makeRes();
  let nextCalled = false;
  await optionalAuthentication(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user.sub, USER_ID);
  assert.equal(res.statusCode, null);
});

test('optionalAuthentication: a supplied token for a DISABLED user is REJECTED, not silently downgraded to anonymous', async () => {
  const repo = makeStatusRepo();
  repo._seedUser({ id: USER_ID, tenant_id: TENANT_A, status: 'DISABLED' });
  setStatusRepo(repo);
  const req = makeReq(issueToken()); const res = makeRes();
  let nextCalled = false;
  await optionalAuthentication(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'a rejected credential must not fall through to anonymous access');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'account_not_active');
  assert.equal(req.user, undefined);
});

test('optionalAuthentication: a garbage token is rejected, not treated as anonymous', async () => {
  const req = makeReq('not-a-real-jwt'); const res = makeRes();
  let nextCalled = false;
  await optionalAuthentication(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'invalid_or_expired_token');
});

test('optionalAuthentication: NO STATUS REPO WIRED + a token IS supplied -> fails closed (401), same as authentication', async () => {
  setStatusRepo(null);
  const req = makeReq(issueToken()); const res = makeRes();
  let nextCalled = false;
  await optionalAuthentication(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'authentication_required');
});
