'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { createApp } = require('../src/app');

test('JWT tenant_id wins over spoofed X-Tenant-Id header', async () => {
  const repos = fx.makeFakeRepos();
  const db    = fx.makeFakeDb();
  const app   = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    // Token says tenant = TENANT_A
    const tk = fx.issueTestToken({ tenantId: fx.TENANT_A, roleCodes: ['corporate_admin'] });
    // Caller spoofs X-Tenant-Id to TENANT_B
    const r = await fx.fetchJson(url + '/api/core/commands/foo.bar', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Tenant-Id': fx.TENANT_B }, fx.authHeader(tk)),
      body: JSON.stringify({})
    });
    // Request still resolves (against TENANT_A from token); the audit row
    // must carry tenant_id = TENANT_A, NOT the spoofed TENANT_B.
    assert.equal(r.status, 400);
    const attempt = db.auditRows.find(x => x.event_type === 'command.attempted');
    assert.ok(attempt, 'expected command.attempted audit row');
    assert.equal(attempt.tenant_id, fx.TENANT_A, 'audit must use JWT tenant, not spoof');
  } finally { srv.close(); }
});

test('No bearer + no tenant header on /api/core -> 401', async () => {
  const repos = fx.makeFakeRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/core/commands/x.y', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'authentication_required');
  } finally { srv.close(); }
});

test('X-Tenant-Id only (no bearer) is no longer accepted on /api/core', async () => {
  const repos = fx.makeFakeRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/core/commands/x.y', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': fx.TENANT_A },
      body: JSON.stringify({})
    });
    assert.equal(r.status, 401, 'header alone must not unlock the route anymore');
  } finally { srv.close(); }
});

test('Invalid JWT -> 401 invalid_or_expired_token', async () => {
  const repos = fx.makeFakeRepos();
  const app   = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/core/commands/x.y', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer not.a.real.token' },
      body: JSON.stringify({})
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'invalid_or_expired_token');
  } finally { srv.close(); }
});
