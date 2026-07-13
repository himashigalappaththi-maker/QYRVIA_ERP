'use strict';

/**
 * Phase 47 — Frontend API Bridge contract tests.
 *
 * These tests validate the exact request/response shapes that the Phase 47
 * browser bridge relies on.  They are not UI tests; they verify that the
 * server-side contracts assumed by the bridge remain stable.
 *
 * Contracts under test:
 *   GET  /api/gatepass        → {ok,data:[]} envelope; agent sees own records only
 *   POST /api/gatepass        → 201 {ok,data:{id,pass_no,...}}; movement mapping accepted
 *   POST /api/gatepass/:id/scan → 200 {ok,data:{scans}}
 *   GET  /api/pos/orders      → {ok,data:[]} envelope; agent sees own records only
 *   POST /api/pos/orders      → 201 {ok,data:{id,type,table_ref,items,...}}
 */

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createApp } = require('../src/app');

// ── IDs ──────────────────────────────────────────────────────────────────────

const AGENT_ID = fx.USER_ID; // 'cccccccc-cccc-1ccc-cccc-cccccccccccc'
const ADMIN_ID = 'ffffffff-ffff-1fff-ffff-ffffffffffff';

const AGENT_PERMS = ['gatepass.read', 'gatepass.write', 'pos.order.read', 'pos.order.write'];
const ADMIN_PERMS = ['gatepass.read', 'gatepass.write', 'pos.order.read', 'pos.order.write'];

// ── In-memory repos (mirrors Phase 46B) ──────────────────────────────────────

function makeGatepasRepo() {
  const rows = [];
  return {
    async list(ctx)                 { return rows.filter(r => r.tenant_id === ctx.tenantId); },
    async create(record)            { const r = Object.assign({ id: 'gp-' + Date.now() + '-' + Math.random(), scans: [], created_at: new Date().toISOString() }, record); rows.push(r); return r; },
    async recordScan(id, body, ctx) { const r = rows.find(x => x.id === id); if (!r) return null; r.scans.push({ ts: new Date().toISOString(), dir: body.direction || 'IN', scanned_by: ctx.actorId }); return r; },
    _seed(row) { rows.push(row); },
    _rows: rows,
  };
}

function makePosOrderRepo() {
  const rows = [];
  return {
    async list(ctx)      { return rows.filter(r => r.tenant_id === ctx.tenantId); },
    async create(record) { const r = Object.assign({ id: 'ord-' + Date.now() + '-' + Math.random(), created_at: new Date().toISOString() }, record); rows.push(r); return r; },
    _seed(row) { rows.push(row); },
    _rows: rows,
  };
}

function makeApp() {
  const repos       = fx.makeFakeRepos();
  const gatepasRepo = makeGatepasRepo();
  const posOrderRepo= makePosOrderRepo();
  repos.identityRepo._seedUser({ id: AGENT_ID, username: 'agent_a', tenant_id: fx.TENANT_A }, [], AGENT_PERMS);
  repos.identityRepo._seedUser({ id: ADMIN_ID, username: 'admin',   tenant_id: fx.TENANT_A }, [], ADMIN_PERMS);
  const app = createApp({ db: fx.makeFakeDb(), identityRepo: repos.identityRepo, tokensRepo: repos.tokensRepo, gatepasRepo, posOrderRepo });
  return { app, gatepasRepo, posOrderRepo };
}

// ── Gate Pass list ────────────────────────────────────────────────────────────

test('GET /api/gatepass returns {ok,data:[]} envelope for authenticated agent', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, 'ok flag must be true');
    assert.ok(Array.isArray(r.body.data), 'data must be an array');
  } finally { srv.close(); }
});

test('GET /api/gatepass returns 401 without token (bridge cannot use it without auth)', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const r = await fx.fetchJson(url + '/api/gatepass');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

// ── Gate Pass create ──────────────────────────────────────────────────────────

test('POST /api/gatepass: agent creates GUEST pass — returns 201 with id and pass_no', async () => {
  const { app, gatepasRepo } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'GUEST', name: 'Mr Test', reservation_id: 'RES-001',
                             movement: 'IN', purpose: 'site visit', valid_from: '2026-07-08T00:00:00Z' }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    const rec = r.body.data;
    assert.ok(rec.id,       'response must include id');
    assert.ok(rec.pass_no,  'response must include pass_no');
    assert.equal(rec.type,  'GUEST');
    assert.equal(rec.name,  'Mr Test');
    assert.ok(Array.isArray(rec.scans), 'scans must be an array');
    assert.equal(gatepasRepo._rows.length, 1, 'repo must have exactly one record');
  } finally { srv.close(); }
});

test('POST /api/gatepass: movement IN is accepted (maps from frontend GOODS_IN)', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'GUEST', name: 'Goods Delivery', reservation_id: 'RES-002', movement: 'IN' }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.movement, 'IN');
  } finally { srv.close(); }
});

test('POST /api/gatepass: IN/OUT movement accepted (maps from frontend NONE)', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'VISITOR', name: 'Site Tour', reservation_id: 'RES-003', movement: 'IN/OUT' }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.movement, 'IN/OUT');
  } finally { srv.close(); }
});

test('POST /api/gatepass: agent blocked from STAFF type (bridge must not send STAFF for agents)', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'STAFF', name: 'Staff Person', reservation_id: 'RES-004' }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.ok, false);
  } finally { srv.close(); }
});

// ── Gate Pass scan ────────────────────────────────────────────────────────────

test('POST /api/gatepass/:id/scan by admin: returns {ok,data:{scans}}', async () => {
  const { app, gatepasRepo } = makeApp();
  gatepasRepo._seed({ id: 'gp-test-1', tenant_id: fx.TENANT_A, pass_no: 'GP-001', type: 'GUEST',
                      name: 'Test Person', movement: 'IN/OUT', status: 'ACTIVE', scans: [], created_at: new Date().toISOString() });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: ADMIN_ID, roleCodes: ['admin'] });
    const r  = await fx.fetchJson(url + '/api/gatepass/gp-test-1/scan', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ direction: 'IN' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.data.scans) && r.body.data.scans.length > 0, 'scan must be recorded');
  } finally { srv.close(); }
});

test('POST /api/gatepass/:id/scan by agent: returns 403', async () => {
  const { app, gatepasRepo } = makeApp();
  gatepasRepo._seed({ id: 'gp-test-2', tenant_id: fx.TENANT_A, pass_no: 'GP-002', type: 'GUEST',
                      name: 'Another Person', movement: 'IN/OUT', status: 'ACTIVE', scans: [], created_at: new Date().toISOString() });
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/gatepass/gp-test-2/scan', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ direction: 'IN' }),
    });
    assert.equal(r.status, 403, 'agents must not scan — bridge silently ignores this 403');
  } finally { srv.close(); }
});

// ── POS orders list ───────────────────────────────────────────────────────────

test('GET /api/pos/orders returns {ok,data:[]} envelope for authenticated agent', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/pos/orders', { headers: fx.authHeader(tk) });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.data));
  } finally { srv.close(); }
});

// ── POS orders create ─────────────────────────────────────────────────────────

test('POST /api/pos/orders: agent creates Room Service order — returns 201 with id', async () => {
  const { app, posOrderRepo } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'], primaryPropertyId: fx.PROP_ID });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({
        type: 'Room Service', table_ref: '101',
        items: [{ item: 'Caesar Salad', qty: 1, price: 850 }], notes: 'no croutons'
      }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    const rec = r.body.data;
    assert.ok(rec.id,                    'response must include id for _serverId stamp');
    assert.equal(rec.type,   'Room Service');
    assert.equal(rec.table_ref, '101');
    assert.ok(Array.isArray(rec.items) && rec.items.length === 1);
    assert.equal(posOrderRepo._rows.length, 1);
  } finally { srv.close(); }
});

test('POST /api/pos/orders: agent blocked from non-Room-Service type', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ roleCodes: ['agent'] });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Dine-In', table_ref: '5', items: [{ item: 'Burger', qty: 1 }] }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.ok, false);
  } finally { srv.close(); }
});

test('POST /api/pos/orders: admin creates any order type', async () => {
  const { app } = makeApp();
  const { srv, url } = await fx.listen(app);
  try {
    const tk = fx.issueTestToken({ userId: ADMIN_ID, roleCodes: ['admin'], primaryPropertyId: fx.PROP_ID });
    const r  = await fx.fetchJson(url + '/api/pos/orders', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, fx.authHeader(tk)),
      body: JSON.stringify({ type: 'Dine-In', table_ref: 'T3', items: [{ item: 'Pizza', qty: 2 }] }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.type, 'Dine-In');
  } finally { srv.close(); }
});

// ── Phase 47 bridge behaviour tests ──────────────────────────────────────────
//
// These tests run the Phase 47 browser bridge in a Node.js vm context with
// mocked browser globals.  They prove three critical invariants:
//   a. gpCreate does NOT fall back to localStorage on 401/403 (server rejection).
//   b. saveKOT UNDOES the local write when the server returns 401/403/4xx.
//   c. Both functions fall back / keep local saves on network-unavailable errors.

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

// Extract the Phase 47 bridge IIFE from the HTML (between the comment marker
// and the closing </script> tag that follows it).
const _HTML_PATH = path.join(__dirname, '../../QYRVIA_ERP_V35-1.html');
function _loadBridgeScript() {
  const html   = fs.readFileSync(_HTML_PATH, 'utf8');
  const marker = '/* ── Phase 47: Frontend API Bridge';
  const start  = html.indexOf(marker);
  if (start === -1) throw new Error('Phase 47 bridge marker not found in HTML');
  const end = html.indexOf('</script>', start);
  if (end === -1) throw new Error('Phase 47 bridge </script> not found');
  return html.slice(start, end).trim();
}
const BRIDGE_SCRIPT = _loadBridgeScript();

function makeMockStorage(initial = {}) {
  const store = Object.assign({}, initial);
  return {
    getItem:    (k) => (k in store ? store[k] : null),
    setItem:    (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store:     store,
  };
}

// Runs the Phase 47 bridge in a vm context and returns the enriched context.
// opts.fetch        — mock for the global fetch() function
// opts.storage      — initial localStorage key/value pairs (plain object)
// opts.origGpCreate — function to install as window.gpCreate before bridge runs
// opts.origSaveKOT  — function to install as window.saveKOT before bridge runs
function runBridge(opts = {}) {
  const toastCalls = [];
  const storage    = makeMockStorage(opts.storage || {});

  const ctx = vm.createContext({
    // Primitives needed by the bridge
    Promise,
    setTimeout,
    clearTimeout,
    JSON,
    Array,
    Object,
    String,
    // Browser APIs (mocked)
    fetch:        opts.fetch || (() => Promise.reject(new Error('fetch not configured'))),
    localStorage: storage,
    document:     opts.document || { getElementById: () => null },
    toast:        (msg, type) => toastCalls.push({ msg, type }),
    renderKOT:    () => {},
    gpRender:     () => {},
    // Pre-bridge window globals the bridge wraps
    gpCreate:     opts.origGpCreate || (() => {}),
    gpScan:       () => {},
    showPage:     (_pg) => {},
    saveKOT:      opts.origSaveKOT  || (() => {}),
    AUTH:         opts.AUTH || null,
  });
  // Bridge IIFE receives `window` as its parameter; make ctx.window === ctx
  ctx.window = ctx;

  vm.runInContext(BRIDGE_SCRIPT, ctx);

  return { ctx, storage, toastCalls };
}

// Helper: flush microtasks + one macrotask tick
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── a. gpCreate: no local fallback on 401/403 ────────────────────────────────

test('bridge gpCreate: 403 — original NOT called, no pass in localStorage', async () => {
  let origCalled = false;
  const { ctx, storage, toastCalls } = runBridge({
    fetch: () => Promise.resolve({
      ok: false, status: 403,
      json: () => Promise.resolve({ ok: false, error: 'Agents may only issue GUEST or VISITOR passes' }),
    }),
    origGpCreate: () => { origCalled = true; },
    document: {
      getElementById: (id) => {
        const v = { gpName: 'Staff Person', gpType: 'STAFF', gpMovement: 'NONE', gpRef: 'RES-1', gpValid: '', gpPurpose: '' }[id];
        return v != null ? { value: v, innerHTML: '' } : null;
      },
    },
  });

  ctx.gpCreate();         // call the Phase 47 wrapped version
  await flushAsync();
  await flushAsync();     // two ticks — one for fetch, one for .then()

  assert.equal(origCalled, false, 'original gpCreate must NOT be called on 403');
  const passes = JSON.parse(storage.getItem('qv_gatepass_v1') || '[]');
  assert.equal(passes.length, 0, 'no gate pass must be written to localStorage on 403');
  assert.ok(toastCalls.some((t) => t.type === 'error'), 'an error toast must be shown');
});

test('bridge gpCreate: 401 — original NOT called, no pass in localStorage', async () => {
  let origCalled = false;
  const { ctx, storage } = runBridge({
    fetch: () => Promise.resolve({
      ok: false, status: 401,
      json: () => Promise.resolve({ ok: false, error: 'Unauthorized' }),
    }),
    origGpCreate: () => { origCalled = true; },
    document: {
      getElementById: (id) => {
        // Must supply a non-empty gpName or the bridge returns early before fetch
        const v = { gpName: 'Test Person', gpType: 'GUEST', gpMovement: 'IN/OUT', gpRef: 'RES-1', gpValid: '', gpPurpose: '' }[id];
        return v != null ? { value: v, innerHTML: '' } : null;
      },
    },
  });

  ctx.gpCreate();
  await flushAsync();
  await flushAsync();

  assert.equal(origCalled, false, 'original gpCreate must NOT be called on 401');
  const passes = JSON.parse(storage.getItem('qv_gatepass_v1') || '[]');
  assert.equal(passes.length, 0, 'no gate pass must be written to localStorage on 401');
});

// ── b. saveKOT: UNDO local save on 401/403 ───────────────────────────────────

test('bridge saveKOT: 403 — local write is rolled back', async () => {
  const KOT_KEY = 'gk_kots';
  const TOKEN   = 'gk_v26_token';

  const storage = makeMockStorage({ [TOKEN]: 'test.jwt.token' });
  const toastCalls = [];

  // Build a ctx manually so origSaveKOT can reference the same storage
  const ctx = vm.createContext({
    Promise, setTimeout, clearTimeout, JSON, Array, Object, String,
    fetch: () => Promise.resolve({
      ok: false, status: 403,
      json: () => Promise.resolve({ ok: false, error: 'Agents may only create Room Service orders' }),
    }),
    localStorage: storage,
    document: { getElementById: () => null },
    toast: (msg, type) => toastCalls.push({ msg, type }),
    renderKOT: () => {},
    gpRender: () => {},
    gpCreate: () => {},
    gpScan:   () => {},
    showPage: () => {},
    saveKOT: () => {
      // Simulate original saveKOT writing a KOT to localStorage
      const kots = JSON.parse(storage.getItem(KOT_KEY) || '[]');
      kots.push({ id: 'kot-test-1', table: '101', type: 'Room Service',
                  items: [{ item: 'Tea', qty: 1 }], notes: '' });
      storage.setItem(KOT_KEY, JSON.stringify(kots));
    },
    AUTH: null,
  });
  ctx.window = ctx;
  vm.runInContext(BRIDGE_SCRIPT, ctx);

  ctx.saveKOT(false, false);   // Phase 47 wrapped version
  await flushAsync();
  await flushAsync();

  const remaining = JSON.parse(storage.getItem(KOT_KEY) || '[]');
  assert.equal(remaining.length, 0, 'KOT must be removed from localStorage after 403 rollback');
  assert.ok(toastCalls.some((t) => t.type === 'error'), 'error toast must be shown after 403 rollback');
});

test('bridge saveKOT: 401 — local write is rolled back', async () => {
  const KOT_KEY = 'gk_kots';
  const TOKEN   = 'gk_v26_token';

  const storage = makeMockStorage({ [TOKEN]: 'test.jwt.token' });
  const toastCalls = [];

  const ctx = vm.createContext({
    Promise, setTimeout, clearTimeout, JSON, Array, Object, String,
    fetch: () => Promise.resolve({
      ok: false, status: 401,
      json: () => Promise.resolve({ ok: false, error: 'Unauthorized' }),
    }),
    localStorage: storage,
    document: { getElementById: () => null },
    toast: (msg, type) => toastCalls.push({ msg, type }),
    renderKOT: () => {},
    gpRender: () => {},
    gpCreate: () => {},
    gpScan:   () => {},
    showPage: () => {},
    saveKOT: () => {
      const kots = JSON.parse(storage.getItem(KOT_KEY) || '[]');
      kots.push({ id: 'kot-test-2', table: '202', type: 'Room Service',
                  items: [{ item: 'Coffee', qty: 2 }], notes: '' });
      storage.setItem(KOT_KEY, JSON.stringify(kots));
    },
    AUTH: null,
  });
  ctx.window = ctx;
  vm.runInContext(BRIDGE_SCRIPT, ctx);

  ctx.saveKOT(false, false);
  await flushAsync();
  await flushAsync();

  const remaining = JSON.parse(storage.getItem(KOT_KEY) || '[]');
  assert.equal(remaining.length, 0, 'KOT must be removed from localStorage after 401 rollback');
  assert.ok(toastCalls.some((t) => t.type === 'error'), 'error toast must be shown after 401 rollback');
});

// ── c. Offline/network-unavailable fallback still works ───────────────────────

test('bridge gpCreate: network error — original IS called (offline fallback)', async () => {
  let origCalled = false;
  const { ctx } = runBridge({
    fetch: () => Promise.reject(new Error('Network error')),
    origGpCreate: () => { origCalled = true; },
  });

  ctx.gpCreate();
  await flushAsync();
  await flushAsync();

  assert.equal(origCalled, true, 'original gpCreate must be called when fetch throws (offline)');
});

test('bridge saveKOT: network error — local write is KEPT (offline fallback)', async () => {
  const KOT_KEY = 'gk_kots';
  const TOKEN   = 'gk_v26_token';

  const storage = makeMockStorage({ [TOKEN]: 'test.jwt.token' });
  const toastCalls = [];

  const ctx = vm.createContext({
    Promise, setTimeout, clearTimeout, JSON, Array, Object, String,
    fetch: () => Promise.reject(new Error('Network error')),
    localStorage: storage,
    document: { getElementById: () => null },
    toast: (msg, type) => toastCalls.push({ msg, type }),
    renderKOT: () => {},
    gpRender: () => {},
    gpCreate: () => {},
    gpScan:   () => {},
    showPage: () => {},
    saveKOT: () => {
      const kots = JSON.parse(storage.getItem(KOT_KEY) || '[]');
      kots.push({ id: 'kot-offline-1', table: '303', type: 'Room Service',
                  items: [{ item: 'Juice', qty: 1 }], notes: '' });
      storage.setItem(KOT_KEY, JSON.stringify(kots));
    },
    AUTH: null,
  });
  ctx.window = ctx;
  vm.runInContext(BRIDGE_SCRIPT, ctx);

  ctx.saveKOT(false, false);
  await flushAsync();
  await flushAsync();

  const remaining = JSON.parse(storage.getItem(KOT_KEY) || '[]');
  assert.equal(remaining.length, 1, 'KOT must be KEPT in localStorage when fetch throws (offline)');
  assert.equal(toastCalls.filter((t) => t.type === 'error').length, 0, 'no error toast on network failure — offline mode');
});
