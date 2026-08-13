'use strict';

/**
 * Phase 67A-004 Workstream A — server/test/_fixtures.js compatibility
 * contract tests.
 *
 * Proves the repaired identityRepo fixture accurately supports the
 * production authentication contract (withTenant + a tenant/status-aware
 * findUserById), per Continue.txt's Section 6 required test list. Pure
 * unit tests against the fixture directly, plus HTTP-level tests through
 * the real createApp() + real authentication middleware — no PostgreSQL
 * connection.
 */

const { test } = require('node:test');
const assert    = require('node:assert/strict');

const fx = require('./_fixtures');
const { createApp } = require('../src/app');

// ── withTenant ───────────────────────────────────────────────────────────

test('fixture: identityRepo.withTenant supplies the requested tenant context to its callback', async () => {
  const repos = fx.makeFakeRepos();
  let captured = null;
  await repos.identityRepo.withTenant('some-tenant-id', async (client) => {
    captured = client;
  });
  assert.deepEqual(captured, { tenantId: 'some-tenant-id' });
});

// ── findUserById: tenant isolation ──────────────────────────────────────

test('fixture: findUserById returns an ACTIVE same-tenant user', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A, status: 'ACTIVE' });
  const row = await repos.identityRepo.findUserById('u1', { tenantId: fx.TENANT_A });
  assert.ok(row);
  assert.equal(row.id, 'u1');
  assert.equal(row.status, 'ACTIVE');
});

test('fixture: findUserById does NOT return a user belonging to a different tenant', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A, status: 'ACTIVE' });
  const row = await repos.identityRepo.findUserById('u1', { tenantId: fx.TENANT_B });
  assert.equal(row, null);
});

test('fixture: findUserById returns null for a missing user id', async () => {
  const repos = fx.makeFakeRepos();
  const row = await repos.identityRepo.findUserById('does-not-exist', { tenantId: fx.TENANT_A });
  assert.equal(row, null);
});

test('fixture: findUserById returns null for a soft-deleted user', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A, status: 'ACTIVE', soft_deleted_at: new Date().toISOString() });
  const row = await repos.identityRepo.findUserById('u1', { tenantId: fx.TENANT_A });
  assert.equal(row, null);
});

test('fixture: findUserById preserves DISABLED status (not silently normalized to ACTIVE)', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A, status: 'DISABLED' });
  const row = await repos.identityRepo.findUserById('u1', { tenantId: fx.TENANT_A });
  assert.ok(row);
  assert.equal(row.status, 'DISABLED');
});

test('fixture: findUserById preserves TERMINATED status', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A, status: 'TERMINATED' });
  const row = await repos.identityRepo.findUserById('u1', { tenantId: fx.TENANT_A });
  assert.ok(row);
  assert.equal(row.status, 'TERMINATED');
});

test('fixture: findUserById preserves LOCKED and PENDING_PASSWORD_RESET status', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A, status: 'LOCKED' });
  repos.identityRepo._seedUser({ id: 'u2', tenant_id: fx.TENANT_A, status: 'PENDING_PASSWORD_RESET' });
  assert.equal((await repos.identityRepo.findUserById('u1', { tenantId: fx.TENANT_A })).status, 'LOCKED');
  assert.equal((await repos.identityRepo.findUserById('u2', { tenantId: fx.TENANT_A })).status, 'PENDING_PASSWORD_RESET');
});

test('fixture: _seedUser defaults status to ACTIVE when the test does not specify one', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A }); // no status given
  const row = await repos.identityRepo.findUserById('u1', { tenantId: fx.TENANT_A });
  assert.equal(row.status, 'ACTIVE');
});

test('fixture: findUserById with no client at all (legacy 1-arg callers) skips tenant scoping but still enforces soft-delete', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: 'u1', tenant_id: fx.TENANT_A, status: 'ACTIVE' });
  repos.identityRepo._seedUser({ id: 'u2', tenant_id: fx.TENANT_A, status: 'ACTIVE', soft_deleted_at: new Date().toISOString() });
  assert.ok(await repos.identityRepo.findUserById('u1'));
  assert.equal(await repos.identityRepo.findUserById('u2'), null);
});

// ── HTTP-level: real createApp() + real authentication middleware ───────

function appWith(repos) {
  return createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
}

async function getMe(app, token) {
  const { srv, url } = await fx.listen(app);
  try {
    return await fx.fetchJson(url + '/api/auth/me', token ? { headers: fx.authHeader(token) } : {});
  } finally { srv.close(); }
}

test('fixture: createApp boots with a functional status repository (setStatusRepo wired, not null)', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'jane', status: 'ACTIVE' });
  const app = appWith(repos);
  const tk = fx.issueTestToken({ roleCodes: ['corporate_admin'] });
  const r = await getMe(app, tk);
  // A functional status repo must have been consulted (not merely absent) —
  // proven by the ACTIVE user succeeding at all under the now-fail-closed
  // authentication.js, which requires a real repo to reach this outcome.
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('fixture: protected route succeeds for an ACTIVE fixture user', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'jane', status: 'ACTIVE' });
  const app = appWith(repos);
  const r = await getMe(app, fx.issueTestToken({ roleCodes: ['corporate_admin'] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.id, fx.USER_ID);
});

test('fixture: protected route rejects a DISABLED fixture user', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'jane', status: 'DISABLED' });
  const app = appWith(repos);
  const r = await getMe(app, fx.issueTestToken({ roleCodes: ['corporate_admin'] }));
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'account_not_active');
});

test('fixture: protected route rejects a TERMINATED fixture user', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, tenant_id: fx.TENANT_A, username: 'jane', status: 'TERMINATED' });
  const app = appWith(repos);
  const r = await getMe(app, fx.issueTestToken({ roleCodes: ['corporate_admin'] }));
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'account_not_active');
});

test('fixture: no test can obtain protected access merely because the repository was not wired (identityRepo lacking withTenant)', async () => {
  // Explicitly build an identityRepo override with NO withTenant, simulating
  // a "repository not wired" scenario end to end through the real app.
  const repos = fx.makeFakeRepos({
    identityRepo: { withTenant: undefined, findUserById: undefined }
  });
  const app = appWith(repos);
  const r = await getMe(app, fx.issueTestToken({ roleCodes: ['corporate_admin'] }));
  assert.equal(r.status, 401, 'a missing status repository must never be treated as acceptable — fail closed');
});
