'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { createApp } = require('../src/app');

test('GET /api/health/live -> 200 ok with uptime (no auth needed)', async () => {
  const app = createApp({ db: fx.makeFakeDb() });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/health/live');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.match(r.headers['x-request-id'], /.+/);
  } finally { srv.close(); }
});

test('GET /api/health/ready -> 200 when db.ping ok', async () => {
  const app = createApp({ db: fx.makeFakeDb({ pingResult: true }) });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/health/ready');
    assert.equal(r.status, 200);
    assert.equal(r.body.db, 'ok');
  } finally { srv.close(); }
});

test('GET /api/health/ready -> 503 when db.ping throws', async () => {
  const app = createApp({ db: fx.makeFakeDb({ pingResult: new Error('db_down') }) });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/health/ready');
    assert.equal(r.status, 503);
    assert.equal(r.body.db, 'down');
    assert.equal(r.body.error, 'db_down');
  } finally { srv.close(); }
});

test('POST /api/core/commands/foo WITHOUT bearer -> 401 authentication_required', async () => {
  const repos = fx.makeFakeRepos();
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/core/commands/foo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'authentication_required');
  } finally { srv.close(); }
});

test('POST /api/core/commands/foo with bearer + unregistered cmd -> 400 command_not_registered', async () => {
  const repos = fx.makeFakeRepos();
  const db    = fx.makeFakeDb();
  const app   = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['corporate_admin'] });
    const r  = await fx.fetchJson(url + '/api/core/commands/foo.bar', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ hello: 'world' })
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'command_not_registered');
    const types = db.auditRows.map(x => x.event_type).sort();
    assert.deepEqual(types, ['command.attempted', 'command.failed']);
  } finally { srv.close(); }
});

test('GET /api/connector/stripe/probe with bearer -> 200 configured:false', async () => {
  const repos = fx.makeFakeRepos();
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['corporate_admin'] });
    const r = await fx.fetchJson(url + '/api/connector/stripe/probe', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.configured, false);
    assert.equal(r.body.known, true);
  } finally { srv.close(); }
});

test('POST /api/connector/stripe/health with bearer -> 200 healthy:false', async () => {
  const repos = fx.makeFakeRepos();
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['corporate_admin'] });
    const r = await fx.fetchJson(url + '/api/connector/stripe/health', { method: 'POST', headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.healthy, false);
    assert.equal(r.body.error, 'not_configured');
  } finally { srv.close(); }
});

test('GET /unknown -> 404 not_found with requestId', async () => {
  const app = createApp({ db: fx.makeFakeDb() });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/no/such/path');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    assert.match(r.body.requestId, /.+/);
  } finally { srv.close(); }
});

test('X-Request-Id passes through (safe shape)', async () => {
  const app = createApp({ db: fx.makeFakeDb() });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/health/live', { headers: { 'X-Request-Id': 'client-rq-12345' } });
    assert.equal(r.headers['x-request-id'], 'client-rq-12345');
  } finally { srv.close(); }
});
