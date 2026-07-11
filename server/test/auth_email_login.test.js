'use strict';

/**
 * Phase 57 — Email-based login tests.
 *
 * Verifies the new email path in identity.attemptLogin and the /api/auth/login
 * route. The existing username+tenantCode path is untouched (covered by auth.test.js).
 */

const fx       = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { createApp } = require('../src/app');
const identity      = require('../src/services/identity');

const EMAIL   = 'alice@example.com';
const USER_ID = fx.USER_ID;

async function seededRepos({ status = 'ACTIVE', tenantStatus = 'active' } = {}) {
  const repos = fx.makeFakeRepos();
  const passwordHash = await identity.hashPassword('Password1!');
  repos.identityRepo._seedUser(
    {
      id: USER_ID, tenant_id: fx.TENANT_A, tenant_code: 'TENANT-A',
      username: 'alice', email: EMAIL,
      password_hash: passwordHash, full_name: 'Alice Smith',
      primary_property_id: fx.PROP_ID,
      status,
      tenant_status: tenantStatus
    },
    [{ id: 'role-fo', code: 'front_office_manager', scope: 'TENANT', property_id: null }],
    ['pms.reservation.read']
  );
  repos.identityRepo._seedAccessibleProperty({ id: fx.PROP_ID, code: 'PROP-1', name: 'Hotel One', tenant_id: fx.TENANT_A, active: true });
  return repos;
}

function app(repos) {
  return createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo:   repos.tokensRepo
  });
}

// ── Service-level unit tests ──────────────────────────────────────────────────

test('attemptLogin: email path returns ok:true with login_via=email', async () => {
  const repos = await seededRepos();
  const result = await identity.attemptLogin(repos.identityRepo, { email: EMAIL, password: 'Password1!' });
  assert.equal(result.ok, true);
  assert.equal(result.login_via, 'email');
  assert.equal(result.user.email, EMAIL);
  assert.ok(Array.isArray(result.roles));
  assert.ok(Array.isArray(result.permissions));
});

test('attemptLogin: email path returns authorised_properties array', async () => {
  const repos = await seededRepos();
  const result = await identity.attemptLogin(repos.identityRepo, { email: EMAIL, password: 'Password1!' });
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.authorised_properties));
  assert.equal(typeof result.requires_property_selection, 'boolean');
});

test('attemptLogin: email not found returns unknown_user', async () => {
  const repos = await seededRepos();
  const result = await identity.attemptLogin(repos.identityRepo, { email: 'nobody@example.com', password: 'Password1!' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_user');
});

test('attemptLogin: wrong password returns bad_password', async () => {
  const repos = await seededRepos();
  const result = await identity.attemptLogin(repos.identityRepo, { email: EMAIL, password: 'WrongPass!' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_password');
});

test('attemptLogin: DISABLED user returns disabled', async () => {
  const repos = await seededRepos({ status: 'DISABLED' });
  const result = await identity.attemptLogin(repos.identityRepo, { email: EMAIL, password: 'Password1!' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disabled');
});

test('attemptLogin: TERMINATED user returns terminated', async () => {
  const repos = await seededRepos({ status: 'TERMINATED' });
  const result = await identity.attemptLogin(repos.identityRepo, { email: EMAIL, password: 'Password1!' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'terminated');
});

test('attemptLogin: inactive tenant returns tenant_inactive', async () => {
  const repos = await seededRepos({ tenantStatus: 'suspended' });
  const result = await identity.attemptLogin(repos.identityRepo, { email: EMAIL, password: 'Password1!' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tenant_inactive');
});

test('attemptLogin: email lookup is case-insensitive', async () => {
  const repos = await seededRepos();
  const result = await identity.attemptLogin(repos.identityRepo, { email: 'ALICE@EXAMPLE.COM', password: 'Password1!' });
  assert.equal(result.ok, true);
  assert.equal(result.user.email, EMAIL);
});

test('attemptLogin: email+username+tenantCode falls to legacy path and succeeds', async () => {
  const repos = await seededRepos();
  // When username is present, the email path is NOT used regardless of email being present.
  // The legacy tenant_code+username path runs and succeeds with valid credentials.
  const result = await identity.attemptLogin(repos.identityRepo,
    { email: EMAIL, username: 'alice', tenantCode: 'TENANT-A', password: 'Password1!' });
  assert.equal(result.ok, true);
  assert.equal(result.login_via, 'tenant_code');
});

test('attemptLogin: username with both tenantCode+propertyCode returns invalid_login_identifiers', async () => {
  const repos = await seededRepos();
  // Legacy path rejects if BOTH tenantCode and propertyCode are provided.
  const result = await identity.attemptLogin(repos.identityRepo,
    { username: 'alice', tenantCode: 'TENANT-A', propertyCode: 'PROP-1', password: 'Password1!' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_login_identifiers');
});

// ── HTTP route tests ──────────────────────────────────────────────────────────

test('POST /api/auth/login with email+password -> 200 + tokens + requires_property_selection', async () => {
  const repos = await seededRepos();
  const { srv, url } = await fx.listen(app(repos));
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: 'Password1!' })
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.access_token, 'access_token missing');
    assert.ok(r.body.refresh_token, 'refresh_token missing');
    assert.equal(r.body.user.email, EMAIL);
    assert.equal(typeof r.body.requires_property_selection, 'boolean');
    assert.ok(Array.isArray(r.body.authorised_properties));
  } finally { srv.close(); }
});

test('POST /api/auth/login with bad email password -> 401', async () => {
  const repos = await seededRepos();
  const { srv, url } = await fx.listen(app(repos));
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: 'BadPass!' })
    });
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('POST /api/auth/login with unknown email -> 401 unknown_user', async () => {
  const repos = await seededRepos();
  const { srv, url } = await fx.listen(app(repos));
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ghost@example.com', password: 'Password1!' })
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unknown_user');
  } finally { srv.close(); }
});

test('POST /api/auth/login with no fields -> 400', async () => {
  const repos = await seededRepos();
  const { srv, url } = await fx.listen(app(repos));
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.ok(r.status >= 400);
  } finally { srv.close(); }
});

test('POST /api/auth/login with email path: requires_property_selection=false when single property', async () => {
  const repos = await seededRepos();
  const { srv, url } = await fx.listen(app(repos));
  try {
    const r = await fx.fetchJson(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: 'Password1!' })
    });
    assert.equal(r.status, 200);
    // Fixture seeds one accessible property → requires_property_selection must be false
    assert.equal(r.body.requires_property_selection, false);
  } finally { srv.close(); }
});
