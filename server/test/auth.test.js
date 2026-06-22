'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { createApp } = require('../src/app');
const identity      = require('../src/services/identity');

async function seededRepos() {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('Secret123');
  repos.identityRepo._seedUser(
    {
      id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'jane.doe', email: 'jane@example.com',
      password_hash: passwordHash, full_name: 'Jane Doe',
      primary_property_id: null, status: 'ACTIVE'
    },
    [{ id: 'role-corporate_admin', code: 'corporate_admin', scope: 'TENANT', property_id: null }],
    ['ap.invoice.post', 'ar.invoice.create']
  );
  return repos;
}

test('POST /api/auth/login with bad creds -> 401', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', username: 'jane.doe', password: 'WRONG' })
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'bad_password');
  } finally { srv.close(); }
});

test('POST /api/auth/login with unknown user -> 401 unknown_user', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', username: 'nobody', password: 'x' })
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unknown_user');
  } finally { srv.close(); }
});

test('POST /api/auth/login with correct creds -> 200 + access + refresh + user + roles + perms', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', username: 'jane.doe', password: 'Secret123' })
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.access_token);
    assert.ok(r.body.refresh_token);
    assert.equal(r.body.user.username, 'jane.doe');
    assert.equal(r.body.roles[0].code, 'corporate_admin');
    assert.deepEqual(r.body.permissions, ['ap.invoice.post', 'ar.invoice.create']);
  } finally { srv.close(); }
});

test('GET /api/auth/me with valid bearer -> 200 with user record', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['corporate_admin'] });
    const r  = await fx.fetchJson(url + '/api/auth/me', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, fx.USER_ID);
    assert.equal(r.body.user.username, 'jane.doe');
  } finally { srv.close(); }
});

test('GET /api/auth/me without bearer -> 401', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/me');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'authentication_required');
  } finally { srv.close(); }
});

test('POST /api/auth/refresh rotates the refresh token', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    // 1. login
    const login = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', username: 'jane.doe', password: 'Secret123' })
    });
    const firstRefresh = login.body.refresh_token;
    // 2. refresh
    const r = await fx.fetchJson(url + '/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: firstRefresh })
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.access_token);
    assert.ok(r.body.refresh_token);
    assert.notEqual(r.body.refresh_token, firstRefresh, 'refresh token should rotate');
  } finally { srv.close(); }
});

test('POST /api/auth/refresh with already-used token -> 401 reused', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const login = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', username: 'jane.doe', password: 'Secret123' })
    });
    const firstRefresh = login.body.refresh_token;
    // First use - rotates
    await fx.fetchJson(url + '/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: firstRefresh })
    });
    // Second use - reuse signal
    const r = await fx.fetchJson(url + '/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: firstRefresh })
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'reused');
  } finally { srv.close(); }
});

test('POST /api/auth/logout revokes the refresh token (and is idempotent)', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const login = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', username: 'jane.doe', password: 'Secret123' })
    });
    const access  = login.body.access_token;
    const refresh = login.body.refresh_token;
    const r = await fx.fetchJson(url + '/api/auth/logout', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(access)),
      body: JSON.stringify({ refresh_token: refresh })
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // Now the refresh token must be unusable
    const r2 = await fx.fetchJson(url + '/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh })
    });
    assert.equal(r2.status, 401);
  } finally { srv.close(); }
});

test('POST /api/auth/login validates required fields -> 400', async () => {
  const repos = await seededRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'jane.doe' })
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'missing_fields');
  } finally { srv.close(); }
});

test('multi-property login: tenant-wide role grants access to any property_id', async () => {
  const repos = await seededRepos();
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_code: 'TENANT-A', username: 'jane.doe', password: 'Secret123',
        property_id: 'dddddddd-dddd-1ddd-dddd-dddddddddddd'
      })
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.primary_property_id, 'dddddddd-dddd-1ddd-dddd-dddddddddddd');
  } finally { srv.close(); }
});

test('multi-property login: property-scoped role denies a different property_id', async () => {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('Secret123');
  // Seed a user whose ONLY role is property-scoped to PROP_ID.
  repos.identityRepo._seedUser(
    {
      id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'jane.doe', password_hash: passwordHash, full_name: 'Jane',
      status: 'ACTIVE'
    },
    [{ id: 'role-front_desk', code: 'front_office_manager', scope: 'PROPERTY', property_id: fx.PROP_ID }],
    []
  );
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_code: 'TENANT-A', username: 'jane.doe', password: 'Secret123',
        property_id: 'eeeeeeee-eeee-1eee-eeee-eeeeeeeeeeee' // different property
      })
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'property_access_denied');
  } finally { srv.close(); }
});

test('disabled user cannot login', async () => {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('Secret123');
  repos.identityRepo._seedUser({
    id: fx.USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
    username: 'jane.doe', password_hash: passwordHash, full_name: 'Jane',
    status: 'DISABLED'
  });
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_code: 'TENANT-A', username: 'jane.doe', password: 'Secret123' })
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'disabled');
  } finally { srv.close(); }
});
