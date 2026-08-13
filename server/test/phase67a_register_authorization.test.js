'use strict';

/**
 * Phase 67A-003 Workstream D — POST /register authorization contract tests.
 *
 * Exercises the ACTUAL HTTP route (routes/auth.js's build(deps), mounted
 * directly — NOT via src/app.js's createApp, since createApp's usual test
 * fixture (_fixtures.js's identityRepo) has no withTenant and would trip
 * the new fail-closed authentication requirement for every request). This
 * file supplies its own minimal, working identityRepo (withTenant +
 * findUserById + findPermissionsForUser + the auth.user.create repo
 * surface), matching what a real production identityRepo provides.
 *
 * auth.user.create is registered on the command bus manually in this file
 * (mirroring exactly what index.js does in production — see index.js's own
 * "Wire the auth.user.create command to its repo + register on the bus"
 * comment) since index.js itself is outside Phase 67A's permitted file
 * scope and is never booted by this test.
 *
 * No PostgreSQL connection. No HTTP server persists past each test (each
 * test opens its own ephemeral listener and closes it in `finally`).
 */

const fx = require('./_fixtures'); // sets JWT_SECRET/etc before tokens.js loads
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const tokens = require('../src/services/tokens');
const authRoutes = require('../src/routes/auth');
const authUserCreate = require('../src/commands/auth.user.create');
const commandBus = require('../src/core/commandBus');

const TENANT_A = 'aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa';
const ADMIN_ID = 'admin-0000-0000-0000-000000000001';

function makeRepo({ adminPermissions = [] } = {}) {
  const users = new Map([[ADMIN_ID, { id: ADMIN_ID, tenant_id: TENANT_A, status: 'ACTIVE' }]]);
  const created = [];
  return {
    _created: created,
    async withTenant(tenantId, cb) { return cb({ tenantId }); },
    async findUserById(id, client) {
      const u = users.get(id);
      if (!u || u.tenant_id !== client.tenantId) return null;
      return u;
    },
    async findPermissionsForUser(userId) {
      return userId === ADMIN_ID ? adminPermissions : [];
    },
    async findUserByTenantUsername() { return null; }, // presence-only gate
    async findUserByTenantUsernameById() { return null; }, // never a duplicate in these tests
    async insertUser(rec) {
      const row = Object.assign({ id: 'u_' + (created.length + 1) }, rec);
      created.push(row);
      return row;
    },
    async insertUserRoleByCode() {}
  };
}

function issueToken({ userId = ADMIN_ID, roleCodes = ['corporate_admin'] } = {}) {
  return tokens.issueAccessToken({ userId, tenantId: TENANT_A, primaryPropertyId: null, roleCodes, roleIds: [] }).token;
}

function buildApp(repo) {
  authUserCreate.setRepo(repo);
  if (!commandBus.list().includes(authUserCreate.name)) {
    try { commandBus.register(authUserCreate); } catch (_) { /* already registered */ }
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.requestId = 'test-req'; next(); });
  app.use('/api/auth', authRoutes.build({ identityRepo: repo, tokensRepo: {} }));
  app.use((err, _req, res, _next) => { res.status(500).json({ error: 'internal_error' }); });
  return app;
}

async function post(app, path, { token, body }) {
  const { srv, url } = await fx.listen(app);
  try {
    return await fx.fetchJson(url + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? fx.authHeader(token) : {}),
      body: JSON.stringify(body || {})
    });
  } finally { srv.close(); }
}

const NEW_USER_INPUT = { username: 'newstaff', password: 'Secret123', full_name: 'New Staff' };

test('POST /register: corporate_admin WITH auth.user.create permission succeeds', async () => {
  const repo = makeRepo({ adminPermissions: ['auth.user.create'] });
  const app  = buildApp(repo);
  const r = await post(app, '/api/auth/register', { token: issueToken(), body: NEW_USER_INPUT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(repo._created.length, 1);
});

test('POST /register: caller WITHOUT auth.user.create permission receives 403 permission_denied', async () => {
  const repo = makeRepo({ adminPermissions: [] }); // corporate_admin token, but repo says NO permissions
  const app  = buildApp(repo);
  const r = await post(app, '/api/auth/register', { token: issueToken(), body: NEW_USER_INPUT });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'permission_denied');
  assert.equal(repo._created.length, 0, 'no user should be created when denied');
});

test('POST /register: super_admin succeeds regardless of the permissions list (command-bus bypass)', async () => {
  const repo = makeRepo({ adminPermissions: [] }); // deliberately empty — proves it's the ROLE bypass, not a permission grant
  const app  = buildApp(repo);
  const r = await post(app, '/api/auth/register', { token: issueToken({ roleCodes: ['super_admin'] }), body: NEW_USER_INPUT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(repo._created.length, 1);
});

test('POST /register: a client-supplied "permissions" field in the request body is ignored — authorization is still denied for an unauthorized caller', async () => {
  const repo = makeRepo({ adminPermissions: [] });
  const app  = buildApp(repo);
  const maliciousBody = Object.assign({}, NEW_USER_INPUT, {
    permissions: ['auth.user.create'], // attacker-supplied — must have zero effect
    tenantId: 'attacker-tenant',
    role_codes: ['super_admin']
  });
  const r = await post(app, '/api/auth/register', { token: issueToken(), body: maliciousBody });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'permission_denied');
  assert.equal(repo._created.length, 0);
});

test('POST /register: without a bearer token -> 401, never reaches authorization or the command bus', async () => {
  const repo = makeRepo({ adminPermissions: ['auth.user.create'] });
  const app  = buildApp(repo);
  const r = await post(app, '/api/auth/register', { token: null, body: NEW_USER_INPUT });
  assert.equal(r.status, 401);
  assert.equal(repo._created.length, 0);
});

test('POST /register: a DISABLED caller (even with the right permission) is rejected by authentication before reaching authorization', async () => {
  const repo = makeRepo({ adminPermissions: ['auth.user.create'] });
  repo.findUserById = async (id, client) => {
    if (id !== ADMIN_ID || client.tenantId !== TENANT_A) return null;
    return { id, tenant_id: TENANT_A, status: 'DISABLED' };
  };
  const app = buildApp(repo);
  const r = await post(app, '/api/auth/register', { token: issueToken(), body: NEW_USER_INPUT });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'account_not_active');
  assert.equal(repo._created.length, 0);
});
