'use strict';

/**
 * M1A — Mobile Operational API Prerequisites: wiring, isolation, and audit tests.
 *
 * Proves that:
 *   - Gate Pass, POS, and Patrol repos are injected through normal DI bootstrap.
 *   - Routes return 404 when no repo is provided (empty router sentinel).
 *   - Cross-tenant isolation is enforced at the service layer.
 *   - Client-supplied tenant_id / property_id in request body is silently ignored.
 *   - Unauthorized requests receive 403.
 *   - Mutations (create / scan / toggle / log) produce audit events via runWithAudit.
 */

const fx       = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createApp } = require('../src/app');

// ── In-memory repo factories ─────────────────────────────────────────────────

function makeGatepasRepo() {
  const rows = [];
  return {
    async list(ctx)                 { return rows.filter(r => r.tenant_id === ctx.tenantId); },
    async create(rec, ctx)          { const r = Object.assign({ id: 'gp-' + Date.now(), scans: [], created_at: new Date().toISOString() }, rec); rows.push(r); return r; },
    async recordScan(id, body, ctx) { const r = rows.find(x => x.id === id && x.tenant_id === ctx.tenantId); if (!r) return null; r.scans = r.scans || []; r.scans.push({ ts: new Date().toISOString(), dir: body.direction || 'IN', scanned_by: ctx.actorId }); return r; },
    _seed(row) { rows.push(row); },
    _rows: rows,
  };
}

function makePosOrderRepo() {
  const rows = [];
  return {
    async list(ctx)       { return rows.filter(r => r.tenant_id === ctx.tenantId); },
    async create(rec, ctx){ const r = Object.assign({ id: 'ord-' + Date.now(), created_at: new Date().toISOString() }, rec); rows.push(r); return r; },
    _seed(row) { rows.push(row); },
    _rows: rows,
  };
}

function makePatrolRepo() {
  const points = [];
  const logs   = [];
  let seq = 0;
  return {
    async listPoints(ctx)        { return points.filter(p => p.tenant_id === ctx.tenantId); },
    async createPoint(rec, ctx)  { const p = Object.assign({ id: 'PP' + (++seq), active: true, created_at: new Date().toISOString() }, rec); points.push(p); return p; },
    async togglePoint(id, ctx)   { const p = points.find(x => x.id === id && x.tenant_id === ctx.tenantId); if (!p) return null; p.active = !p.active; return p; },
    async listLogs(ctx)          { return logs.filter(l => l.tenant_id === ctx.tenantId); },
    async createLog(rec, ctx)    { const l = Object.assign({ id: 'PL' + (++seq), created_at: new Date().toISOString() }, rec); logs.push(l); return l; },
    _seedPoint(row) { points.push(row); },
    _seedLog(row)   { logs.push(row); },
    _points: points,
    _logs:   logs,
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

const USER_B_ID   = 'bbbbbbbb-bbbb-1bbb-bbbb-bbbbbbbbbbbb';
const ALL_PERMS   = [
  'gatepass.read', 'gatepass.write',
  'pos.order.read', 'pos.order.write',
  'patrol.point.read', 'patrol.point.write', 'patrol.log.read', 'patrol.log.write',
];

// ── App factories ────────────────────────────────────────────────────────────

function makeApp({ gatepasRepo, posOrderRepo, patrolRepo, db } = {}) {
  const repos = fx.makeFakeRepos();
  const _db   = db || fx.makeFakeDb();
  repos.identityRepo._seedUser({ id: fx.USER_ID, username: 'admin', tenant_id: fx.TENANT_A }, [], ALL_PERMS);
  repos.identityRepo._seedUser({ id: USER_B_ID,  username: 'user_b', tenant_id: fx.TENANT_B }, [], ALL_PERMS);
  const app = createApp({
    db: _db,
    identityRepo: repos.identityRepo,
    tokensRepo:   repos.tokensRepo,
    gatepasRepo,
    posOrderRepo,
    patrolRepo,
  });
  return { app, _db };
}

// ── 1. DI wiring — routes mount live when repo is injected ───────────────────

test('M1A wiring: Gate Pass route is live when gatepasRepo is injected', async () => {
  const { app } = makeApp({ gatepasRepo: makeGatepasRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200, 'live route must return 200 for authenticated list');
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.data));
  } finally { srv.close(); }
});

test('M1A wiring: Gate Pass route is empty (404) without gatepasRepo', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 404, 'empty router must yield 404 for authenticated GET');
  } finally { srv.close(); }
});

test('M1A wiring: POS route is live when posOrderRepo is injected', async () => {
  const { app } = makeApp({ posOrderRepo: makePosOrderRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/pos/orders', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  } finally { srv.close(); }
});

test('M1A wiring: Patrol route is live when patrolRepo is injected', async () => {
  const { app } = makeApp({ patrolRepo: makePatrolRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  } finally { srv.close(); }
});

// ── 2. 401 without token ─────────────────────────────────────────────────────

test('M1A authz: Gate Pass returns 401 without token', async () => {
  const { app } = makeApp({ gatepasRepo: makeGatepasRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/gatepass');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('M1A authz: POS returns 401 without token', async () => {
  const { app } = makeApp({ posOrderRepo: makePosOrderRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/pos/orders');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('M1A authz: Patrol returns 401 without token', async () => {
  const { app } = makeApp({ patrolRepo: makePatrolRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/patrol/points');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

// ── 3. 403 unauthorized ──────────────────────────────────────────────────────

test('M1A authz: Gate Pass create returns 403 without gatepass.write', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, username: 'readonly', tenant_id: fx.TENANT_A }, [], ['gatepass.read']);
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, gatepasRepo: makeGatepasRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'GUEST', name: 'X' }),
    });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

test('M1A authz: POS order create returns 403 without pos.order.write', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, username: 'readonly', tenant_id: fx.TENANT_A }, [], ['pos.order.read']);
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, posOrderRepo: makePosOrderRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'] });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Room Service' }),
    });
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

test('M1A authz: Patrol log create returns 403 for agent (defence-in-depth)', async () => {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, username: 'agent', tenant_id: fx.TENANT_A }, [], ['patrol.log.write']);
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, patrolRepo: makePatrolRepo() });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ point_id: 'PP001' }),
    });
    assert.equal(r.status, 403, 'agent must be blocked from patrol log write even with perm explicitly given');
  } finally { srv.close(); }
});

// ── 4. Cross-tenant isolation ────────────────────────────────────────────────

test('M1A isolation: Gate Pass list returns only TENANT_A data for TENANT_A token', async () => {
  const gpr = makeGatepasRepo();
  gpr._seed({ id: 'gp-a1', tenant_id: fx.TENANT_A, type: 'GUEST', name: 'A Guest', status: 'ACTIVE', created_by_user_id: fx.USER_ID });
  gpr._seed({ id: 'gp-b1', tenant_id: fx.TENANT_B, type: 'GUEST', name: 'B Guest', status: 'ACTIVE', created_by_user_id: USER_B_ID });
  const { app } = makeApp({ gatepasRepo: gpr });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] }); // TENANT_A
    const r  = await fx.fetchJson(url + '/api/gatepass', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.every(p => p.tenant_id === fx.TENANT_A), 'must only return TENANT_A records');
    assert.ok(!r.body.data.some(p => p.id === 'gp-b1'), 'TENANT_B record must not appear');
  } finally { srv.close(); }
});

test('M1A isolation: POS list returns only TENANT_A data for TENANT_A token', async () => {
  const por = makePosOrderRepo();
  por._seed({ id: 'ord-a1', tenant_id: fx.TENANT_A, type: 'Room Service', created_by_user_id: fx.USER_ID });
  por._seed({ id: 'ord-b1', tenant_id: fx.TENANT_B, type: 'Room Service', created_by_user_id: USER_B_ID });
  const { app } = makeApp({ posOrderRepo: por });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] }); // TENANT_A
    const r  = await fx.fetchJson(url + '/api/pos/orders', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.every(o => o.tenant_id === fx.TENANT_A));
    assert.ok(!r.body.data.some(o => o.id === 'ord-b1'), 'TENANT_B order must not appear');
  } finally { srv.close(); }
});

test('M1A isolation: Patrol points list returns only TENANT_A data for TENANT_A token', async () => {
  const pr = makePatrolRepo();
  pr._seedPoint({ id: 'PP-A', tenant_id: fx.TENANT_A, name: 'A Gate', zone: 'Exterior', active: true });
  pr._seedPoint({ id: 'PP-B', tenant_id: fx.TENANT_B, name: 'B Gate', zone: 'Exterior', active: true });
  const { app } = makeApp({ patrolRepo: pr });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.every(p => p.tenant_id === fx.TENANT_A));
    assert.ok(!r.body.data.some(p => p.id === 'PP-B'), 'TENANT_B point must not appear');
  } finally { srv.close(); }
});

test('M1A isolation: Patrol logs list returns only TENANT_A data for TENANT_A token', async () => {
  const pr = makePatrolRepo();
  pr._seedLog({ id: 'PL-A', tenant_id: fx.TENANT_A, point_id: 'PP-A', officer_id: fx.USER_ID, checked_at: new Date().toISOString() });
  pr._seedLog({ id: 'PL-B', tenant_id: fx.TENANT_B, point_id: 'PP-B', officer_id: USER_B_ID, checked_at: new Date().toISOString() });
  const { app } = makeApp({ patrolRepo: pr });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.every(l => l.tenant_id === fx.TENANT_A));
    assert.ok(!r.body.data.some(l => l.id === 'PL-B'), 'TENANT_B log must not appear');
  } finally { srv.close(); }
});

// ── 5. Client tenant_id override is ignored ──────────────────────────────────

test('M1A security: Gate Pass create ignores tenant_id in request body', async () => {
  const gpr = makeGatepasRepo();
  const { app } = makeApp({ gatepasRepo: gpr });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] }); // TENANT_A
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'GUEST', name: 'Spoof', reservation_id: 'R-1', tenant_id: fx.TENANT_B }),
    });
    assert.equal(r.status, 201);
    assert.equal(gpr._rows[0].tenant_id, fx.TENANT_A, 'tenant_id must come from JWT, not body');
  } finally { srv.close(); }
});

test('M1A security: POS order create ignores tenant_id in request body', async () => {
  const por = makePosOrderRepo();
  const { app } = makeApp({ posOrderRepo: por });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'], primaryPropertyId: fx.PROP_ID }); // TENANT_A
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Room Service', items: [], tenant_id: fx.TENANT_B }),
    });
    assert.equal(r.status, 201);
    assert.equal(por._rows[0].tenant_id, fx.TENANT_A, 'tenant_id must come from JWT, not body');
  } finally { srv.close(); }
});

test('M1A security: Patrol point create ignores tenant_id in request body', async () => {
  const pr = makePatrolRepo();
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, username: 'mgr', tenant_id: fx.TENANT_A }, [], ALL_PERMS);
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, patrolRepo: pr });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: fx.USER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ name: 'Main Gate', tenant_id: fx.TENANT_B }),
    });
    assert.equal(r.status, 201);
    assert.equal(pr._points[0].tenant_id, fx.TENANT_A, 'tenant_id must come from JWT, not body');
  } finally { srv.close(); }
});

// ── 6. Audit evidence ────────────────────────────────────────────────────────

test('M1A audit: Gate Pass create produces command audit events', async () => {
  const gpr = makeGatepasRepo();
  const db  = fx.makeFakeDb();
  const { app } = makeApp({ gatepasRepo: gpr, db });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'GUEST', name: 'Audit Test', reservation_id: 'RES-AUD' }),
    });
    assert.equal(r.status, 201);
    assert.ok(db.auditRows.some(ev => String(ev.event_type || '').startsWith('command.')),
      'at least one command audit event must be recorded for Gate Pass create');
  } finally { srv.close(); }
});

test('M1A audit: Gate Pass scan produces command audit events', async () => {
  const gpr = makeGatepasRepo();
  gpr._seed({ id: 'gp-aud', tenant_id: fx.TENANT_A, type: 'GUEST', name: 'X', status: 'ACTIVE', scans: [] });
  const db  = fx.makeFakeDb();
  const { app } = makeApp({ gatepasRepo: gpr, db });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/gatepass/gp-aud/scan', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ direction: 'IN' }),
    });
    assert.equal(r.status, 200);
    assert.ok(db.auditRows.some(ev => String(ev.event_type || '').startsWith('command.')),
      'Gate Pass scan must produce command audit event');
  } finally { srv.close(); }
});

test('M1A audit: POS order create produces command audit events', async () => {
  const por = makePosOrderRepo();
  const db  = fx.makeFakeDb();
  const { app } = makeApp({ posOrderRepo: por, db });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['admin'], primaryPropertyId: fx.PROP_ID });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Room Service', items: [] }),
    });
    assert.equal(r.status, 201);
    assert.ok(db.auditRows.some(ev => String(ev.event_type || '').startsWith('command.')),
      'POS order create must produce command audit event');
  } finally { srv.close(); }
});

test('M1A audit: Patrol point create produces command audit events', async () => {
  const pr = makePatrolRepo();
  const db = fx.makeFakeDb();
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, username: 'mgr', tenant_id: fx.TENANT_A }, [], ALL_PERMS);
  const app = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, patrolRepo: pr });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: fx.USER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ name: 'Audit Gate', zone: 'Exterior' }),
    });
    assert.equal(r.status, 201);
    assert.ok(db.auditRows.some(ev => String(ev.event_type || '').startsWith('command.')),
      'patrol point create must produce command audit event');
  } finally { srv.close(); }
});

test('M1A audit: Patrol point toggle produces command audit events', async () => {
  const pr = makePatrolRepo();
  pr._seedPoint({ id: 'PP-TOG', tenant_id: fx.TENANT_A, name: 'Toggle Gate', zone: 'Exterior', active: true });
  const db = fx.makeFakeDb();
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, username: 'mgr', tenant_id: fx.TENANT_A }, [], ALL_PERMS);
  const app = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, patrolRepo: pr });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: fx.USER_ID, roleCodes: ['manager'] });
    const r  = await fx.fetchJson(url + '/api/patrol/points/PP-TOG/toggle', {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: '{}',
    });
    assert.equal(r.status, 200);
    assert.ok(db.auditRows.some(ev => String(ev.event_type || '').startsWith('command.')),
      'patrol point toggle must produce command audit event');
  } finally { srv.close(); }
});

test('M1A audit: Patrol log create produces command audit events', async () => {
  const pr = makePatrolRepo();
  const db = fx.makeFakeDb();
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: fx.USER_ID, username: 'security', tenant_id: fx.TENANT_A }, [], ALL_PERMS);
  const app = createApp({ db, identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, patrolRepo: pr });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['security'] });
    const r  = await fx.fetchJson(url + '/api/patrol/logs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ point_id: 'PP-LOG-AUD', gps: { lat: 6.92, lng: 79.86, acc: '5m' } }),
    });
    assert.equal(r.status, 201);
    assert.ok(db.auditRows.some(ev => String(ev.event_type || '').startsWith('command.')),
      'patrol log create must produce command audit event');
  } finally { srv.close(); }
});
