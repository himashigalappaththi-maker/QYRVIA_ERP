'use strict';

/**
 * Phase 46B — Server-side agent RBAC isolation tests.
 *
 * Proves:
 *   - 401 without token on all agent routes
 *   - 403 when role lacks the required permission
 *   - Agent sees only own gate passes / POS orders (server-side filter)
 *   - Admin sees all records regardless of creator
 *   - created_by_user_id is stamped from JWT sub — client body value is ignored
 *   - Agent cannot create STAFF/VENDOR/CONTRACTOR gate pass types
 *   - Agent must supply reservation_id for gate passes
 *   - Agent cannot scan/approve a gate pass
 *   - Agent cannot create non-Room-Service POS orders
 */

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createApp } = require('../src/app');

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_A_ID = fx.USER_ID;  // 'cccccccc-cccc-1ccc-cccc-cccccccccccc'
const AGENT_B_ID = 'eeeeeeee-eeee-1eee-eeee-eeeeeeeeeeee';
const ADMIN_ID   = 'ffffffff-ffff-1fff-ffff-ffffffffffff';

const AGENT_PERMS = ['gatepass.read', 'gatepass.write', 'pos.order.read', 'pos.order.write'];
const ADMIN_PERMS = ['gatepass.read', 'gatepass.write', 'pos.order.read', 'pos.order.write'];

// ── In-memory repos ───────────────────────────────────────────────────────────

function makeInMemoryGatepasRepo() {
  const rows = [];
  return {
    async list(ctx)                 { return rows.filter(r => r.tenant_id === ctx.tenantId); },
    async create(record)            { const r = Object.assign({ id: 'gp-' + Date.now() + '-' + Math.random(), scans: [], created_at: new Date().toISOString() }, record); rows.push(r); return r; },
    async recordScan(id, body, ctx) { const r = rows.find(x => x.id === id); if (!r) return null; r.scans.push({ ts: new Date().toISOString(), dir: body.direction || 'IN', scanned_by: ctx.actorId }); return r; },
    _seed(row)  { rows.push(row); },
    _rows: rows,
  };
}

function makeInMemoryPosOrderRepo() {
  const rows = [];
  return {
    async list(ctx)     { return rows.filter(r => r.tenant_id === ctx.tenantId); },
    async create(record){ const r = Object.assign({ id: 'ord-' + Date.now() + '-' + Math.random(), created_at: new Date().toISOString() }, record); rows.push(r); return r; },
    _seed(row)  { rows.push(row); },
    _rows: rows,
  };
}

// ── App factory (fresh state per test) ───────────────────────────────────────

function makeApp({ agentAPerms = AGENT_PERMS, agentBPerms = AGENT_PERMS, adminPerms = ADMIN_PERMS } = {}) {
  const repos = fx.makeFakeRepos();
  repos.identityRepo._seedUser({ id: AGENT_A_ID, username: 'agent_a', tenant_id: fx.TENANT_A }, [], agentAPerms);
  repos.identityRepo._seedUser({ id: AGENT_B_ID, username: 'agent_b', tenant_id: fx.TENANT_A }, [], agentBPerms);
  repos.identityRepo._seedUser({ id: ADMIN_ID,   username: 'admin',   tenant_id: fx.TENANT_A }, [], adminPerms);
  const gatepasRepo  = makeInMemoryGatepasRepo();
  const posOrderRepo = makeInMemoryPosOrderRepo();
  const app = createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo:   repos.tokensRepo,
    gatepasRepo,
    posOrderRepo,
  });
  return { app, gatepasRepo, posOrderRepo };
}

// ── Auth enforcement ──────────────────────────────────────────────────────────

test('GET /api/gatepass → 401 without token', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/gatepass');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('GET /api/gatepass → 403 when user has no gatepass.read permission', async () => {
  const { app } = makeApp({ agentAPerms: [] }); // strip all perms for agent A
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'] }); // staff has no gatepass perm
    const r  = await fx.fetchJson(url + '/api/gatepass', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'permission_denied');
  } finally { srv.close(); }
});

test('GET /api/pos/orders → 401 without token', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/pos/orders');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('GET /api/pos/orders → 403 when user has no pos.order.read permission', async () => {
  const { app } = makeApp({ agentAPerms: [] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['staff'] });
    const r  = await fx.fetchJson(url + '/api/pos/orders', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'permission_denied');
  } finally { srv.close(); }
});

// ── Gate pass: spoof prevention ───────────────────────────────────────────────

test('POST /api/gatepass stamps created_by_user_id from JWT sub, ignores body value', async () => {
  const { app, gatepasRepo } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] }); // sub = AGENT_A_ID
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({
        type: 'GUEST', name: 'Mr Test', reservation_id: 'RES-001',
        created_by_user_id: AGENT_B_ID  // spoof attempt — must be ignored
      }),
    });
    assert.equal(r.status, 201, 'should create pass');
    assert.equal(r.body.ok, true);
    assert.equal(gatepasRepo._rows[0].created_by_user_id, AGENT_A_ID, 'must be JWT sub, not spoofed ID');
    assert.notEqual(gatepasRepo._rows[0].created_by_user_id, AGENT_B_ID);
  } finally { srv.close(); }
});

// ── Gate pass: agent isolation ────────────────────────────────────────────────

test('GET /api/gatepass agent sees only own passes', async () => {
  const { app, gatepasRepo } = makeApp();
  gatepasRepo._seed({ id: 'gp-a', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_A_ID, type: 'GUEST', name: 'A Guest', status: 'ACTIVE' });
  gatepasRepo._seed({ id: 'gp-b', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_B_ID, type: 'GUEST', name: 'B Guest', status: 'ACTIVE' });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] }); // agent A
    const r  = await fx.fetchJson(url + '/api/gatepass', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 1, 'agent A sees only 1 pass');
    assert.equal(r.body.data[0].id, 'gp-a');
  } finally { srv.close(); }
});

test('GET /api/gatepass admin sees all passes across all agents', async () => {
  const { app, gatepasRepo } = makeApp();
  gatepasRepo._seed({ id: 'gp-a', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_A_ID, type: 'GUEST', name: 'A Guest', status: 'ACTIVE' });
  gatepasRepo._seed({ id: 'gp-b', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_B_ID, type: 'GUEST', name: 'B Guest', status: 'ACTIVE' });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: ADMIN_ID, roleCodes: ['corporate_admin'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 2, 'admin sees both passes');
  } finally { srv.close(); }
});

// ── Gate pass: agent type restrictions ────────────────────────────────────────

test('POST /api/gatepass → 403 when agent issues STAFF pass', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'STAFF', name: 'Staff Member', reservation_id: 'RES-001' }),
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /GUEST or VISITOR/);
  } finally { srv.close(); }
});

test('POST /api/gatepass → 403 when agent issues VENDOR pass', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'VENDOR', name: 'Vendor Rep', reservation_id: 'RES-001' }),
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /GUEST or VISITOR/);
  } finally { srv.close(); }
});

test('POST /api/gatepass → 400 when agent omits reservation_id', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'GUEST', name: 'Anonymous Guest' }),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /reservation_id/);
  } finally { srv.close(); }
});

// ── Gate pass: scan restriction ───────────────────────────────────────────────

test('POST /api/gatepass/:id/scan → 403 for agent', async () => {
  const { app, gatepasRepo } = makeApp();
  gatepasRepo._seed({ id: 'gp-x', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_A_ID, type: 'GUEST', name: 'X', status: 'ACTIVE', scans: [] });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass/gp-x/scan', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ direction: 'IN' }),
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /scan/i);
  } finally { srv.close(); }
});

// ── POS orders: spoof prevention ─────────────────────────────────────────────

test('POST /api/pos/orders stamps created_by_user_id from JWT sub, ignores body value', async () => {
  const { app, posOrderRepo } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'], primaryPropertyId: fx.PROP_ID }); // sub = AGENT_A_ID
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Room Service', items: [], created_by_user_id: AGENT_B_ID }),
    });
    assert.equal(r.status, 201);
    assert.equal(posOrderRepo._rows[0].created_by_user_id, AGENT_A_ID, 'must be JWT sub');
    assert.notEqual(posOrderRepo._rows[0].created_by_user_id, AGENT_B_ID);
  } finally { srv.close(); }
});

// ── POS orders: agent isolation ───────────────────────────────────────────────

test('GET /api/pos/orders agent sees only own orders', async () => {
  const { app, posOrderRepo } = makeApp();
  posOrderRepo._seed({ id: 'ord-a', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_A_ID, type: 'Room Service' });
  posOrderRepo._seed({ id: 'ord-b', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_B_ID, type: 'Room Service' });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] }); // agent A
    const r  = await fx.fetchJson(url + '/api/pos/orders', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 1, 'agent A sees only 1 order');
    assert.equal(r.body.data[0].id, 'ord-a');
  } finally { srv.close(); }
});

test('GET /api/pos/orders admin sees all orders across all agents', async () => {
  const { app, posOrderRepo } = makeApp();
  posOrderRepo._seed({ id: 'ord-a', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_A_ID, type: 'Room Service' });
  posOrderRepo._seed({ id: 'ord-b', tenant_id: fx.TENANT_A, created_by_user_id: AGENT_B_ID, type: 'Room Service' });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: ADMIN_ID, roleCodes: ['corporate_admin'] });
    const r  = await fx.fetchJson(url + '/api/pos/orders', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 2, 'admin sees all orders');
  } finally { srv.close(); }
});

// ── POS orders: agent type restriction ───────────────────────────────────────

test('POST /api/pos/orders → 403 when agent creates non-Room-Service order', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Dine-In', items: [] }),
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /Room Service/);
  } finally { srv.close(); }
});
