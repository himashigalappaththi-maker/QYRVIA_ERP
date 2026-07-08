'use strict';

/**
 * Phase 48 — Security Patrol backend contract tests.
 *
 * Contracts under test:
 *   GET  /api/patrol/points           → {ok, data:[]}
 *   POST /api/patrol/points           → 201 {ok, data:{id,name,zone,...}}; manager/admin only
 *   PATCH /api/patrol/points/:id/toggle → 200 {ok, data:{id,active}}; manager/admin only
 *   GET  /api/patrol/logs             → {ok, data:[]}
 *   POST /api/patrol/logs             → 201 {ok, data:{id,point_id,...}}; NOT agents
 */

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createApp } = require('../src/app');

// ── IDs ──────────────────────────────────────────────────────────────────────

const SECURITY_ID = fx.USER_ID;                              // 'cccccccc-...'
const MANAGER_ID  = 'eeeeeeee-eeee-1eee-eeee-eeeeeeeeeeee';
const AGENT_ID    = 'ffffffff-ffff-1fff-ffff-ffffffffffff';

const SECURITY_PERMS = ['patrol.point.read', 'patrol.log.read', 'patrol.log.write'];
const MANAGER_PERMS  = ['patrol.point.read', 'patrol.point.write', 'patrol.log.read', 'patrol.log.write'];
const AGENT_PERMS    = [];  // agents have no patrol permissions

// ── In-memory repos ──────────────────────────────────────────────────────────

function makePatrolRepo() {
  const points = [];
  const logs   = [];
  let   seq    = 0;

  return {
    async listPoints(ctx)         { return points.filter(p => p.tenant_id === ctx.tenantId); },
    async createPoint(rec)        { const p = Object.assign({ id: 'PP' + String(++seq).padStart(3, '0'), created_at: new Date().toISOString() }, rec); points.push(p); return p; },
    async togglePoint(id, ctx)    { const p = points.find(x => x.id === id && x.tenant_id === ctx.tenantId); if (!p) return null; p.active = !p.active; return p; },
    async listLogs(ctx)           { return logs.filter(l => l.tenant_id === ctx.tenantId); },
    async createLog(rec)          { const l = Object.assign({ id: 'PL' + String(++seq).padStart(3, '0') }, rec); logs.push(l); return l; },
    _seed(type, row)              { (type === 'point' ? points : logs).push(row); },
    _points: points,
    _logs:   logs,
  };
}

function makeApp() {
  const repos      = fx.makeFakeRepos();
  const patrolRepo = makePatrolRepo();
  repos.identityRepo._seedUser({ id: SECURITY_ID, username: 'sec_a',   tenant_id: fx.TENANT_A }, [], SECURITY_PERMS);
  repos.identityRepo._seedUser({ id: MANAGER_ID,  username: 'manager', tenant_id: fx.TENANT_A }, [], MANAGER_PERMS);
  repos.identityRepo._seedUser({ id: AGENT_ID,    username: 'agent_a', tenant_id: fx.TENANT_A }, [], AGENT_PERMS);
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, patrolRepo });
  return { app, patrolRepo };
}

// ── GET /api/patrol/points ────────────────────────────────────────────────────

test('GET /api/patrol/points returns {ok,data:[]} for security user', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.data));
  } finally { srv.close(); }
});

test('GET /api/patrol/points returns 401 without token', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/patrol/points');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('GET /api/patrol/points returns 403 for agent (no patrol.point.read)', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: AGENT_ID, roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

// ── POST /api/patrol/points ───────────────────────────────────────────────────

test('POST /api/patrol/points: manager creates point — returns 201 with id', async () => {
  const { app, patrolRepo } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ name: 'East Wing Exit', zone: 'Exterior', lat: 6.927140, lng: 79.861200 }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    const pt = r.body.data;
    assert.ok(pt.id,            'response must include id');
    assert.equal(pt.name, 'East Wing Exit');
    assert.equal(pt.zone, 'Exterior');
    assert.equal(pt.active, true);
    assert.equal(patrolRepo._points.length, 1);
  } finally { srv.close(); }
});

test('POST /api/patrol/points: defaults zone to Exterior when omitted', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ name: 'Lobby Entrance' }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.zone, 'Exterior');
  } finally { srv.close(); }
});

test('POST /api/patrol/points: 400 when name missing', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ zone: 'Interior' }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  } finally { srv.close(); }
});

test('POST /api/patrol/points: security user cannot create (no patrol.point.write)', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ name: 'Side Gate' }),
    });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

// ── PATCH /api/patrol/points/:id/toggle ──────────────────────────────────────

test('PATCH /api/patrol/points/:id/toggle: manager toggles active→inactive', async () => {
  const { app, patrolRepo } = makeApp();
  patrolRepo._seed('point', { id: 'PP001', tenant_id: fx.TENANT_A, name: 'Main Gate', zone: 'Exterior', active: true });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points/PP001/toggle', {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: '{}',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.active, false, 'active should flip to false');
  } finally { srv.close(); }
});

test('PATCH /api/patrol/points/:id/toggle: 404 for unknown point', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: MANAGER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points/PPXXX/toggle', {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: '{}',
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
  } finally { srv.close(); }
});

// ── GET /api/patrol/logs ──────────────────────────────────────────────────────

test('GET /api/patrol/logs returns {ok,data:[]} for security user', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'] });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.data));
  } finally { srv.close(); }
});

// ── POST /api/patrol/logs ─────────────────────────────────────────────────────

test('POST /api/patrol/logs: security records check-in — returns 201 with id', async () => {
  const { app, patrolRepo } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'] });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ point_id: 'PP001', gps: { lat: '6.927140', lng: '79.861200', acc: '5m' } }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    const log = r.body.data;
    assert.ok(log.id,             'response must include id');
    assert.equal(log.point_id, 'PP001');
    assert.equal(log.officer_id, fx.USER_ID);
    assert.equal(patrolRepo._logs.length, 1);
  } finally { srv.close(); }
});

test('POST /api/patrol/logs: 400 when point_id missing', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'] });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ gps: { lat: '6.9', lng: '79.8', acc: '10m' } }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  } finally { srv.close(); }
});

test('POST /api/patrol/logs: agent is blocked (403) even with patrol.log.write perm explicitly given', async () => {
  const repos      = fx.makeFakeRepos();
  const patrolRepo = makePatrolRepo();
  repos.identityRepo._seedUser({ id: AGENT_ID, username: 'ag', tenant_id: fx.TENANT_A }, [], ['patrol.log.write']);
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, patrolRepo });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: AGENT_ID, roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ point_id: 'PP001' }),
    });
    assert.equal(r.status, 403, 'agents must not record patrol check-ins');
    assert.equal(r.body.ok, false);
  } finally { srv.close(); }
});

test('POST /api/patrol/logs: agent without patrol.log.write gets 403 from requirePermission', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: AGENT_ID, roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ point_id: 'PP001' }),
    });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});
