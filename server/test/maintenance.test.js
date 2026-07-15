'use strict';

/**
 * Phase 59 — Maintenance work orders: route-level unit tests.
 */

// Env sentinels must be set before any app module is required.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';
process.env.LOG_LEVEL    = 'silent';
process.env.NODE_ENV     = 'test';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const maintenanceRouterMod = require('../src/routes/maintenance');

const TENANT_A = 'aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa';
const PROP_A   = 'dddddddd-dddd-1ddd-dddd-dddddddddddd';
const ACTOR_A  = 'cccccccc-cccc-1ccc-cccc-cccccccccccc';
const WO_ID    = 'ffffffff-ffff-1fff-ffff-ffffffffffff';

function makeCtx(overrides = {}) {
  return Object.assign({
    tenantId: TENANT_A, propertyId: PROP_A, actorId: ACTOR_A,
    requestId: 'req-test', roleCodes: ['admin'],
    permissions: [
      'maintenance.read', 'maintenance.create', 'maintenance.assign',
      'maintenance.update', 'maintenance.complete'
    ]
  }, overrides);
}

function makeReq({ body = {}, params = {}, query = {}, ctx } = {}) {
  return { body, params, query, ctx: ctx || makeCtx() };
}

function makeRes() {
  const res = { _status: 200, _body: null,
    status(s) { this._status = s; return this; },
    json(b)   { this._body  = b; return this; }
  };
  return res;
}

function makeNext() {
  const fn = (err) => { fn.called = true; fn.err = err; };
  fn.called = false; fn.err = undefined;
  return fn;
}

// audit pipeline stub
const auditMod = require('../src/audit/pipeline');
const _origRunWithAudit = auditMod.runWithAudit;
function withAuditStub(fn) {
  auditMod.runWithAudit = async (_m, _p, _c, work) => work();
  try { return fn(); }
  finally { auditMod.runWithAudit = _origRunWithAudit; }
}

// Cache-bust helper: installs an audit stub BEFORE re-requiring the route so
// the route's destructured `runWithAudit` binding captures the stub.
function loadRouteWithAuditStub(routePath, auditStub) {
  const resolvedRoute = require.resolve(routePath);
  const pipeline = require('../src/audit/pipeline');
  const origFn = pipeline.runWithAudit;
  pipeline.runWithAudit = auditStub;
  delete require.cache[resolvedRoute];
  const routeModule = require(resolvedRoute);
  return {
    routeModule,
    restore() {
      pipeline.runWithAudit = origFn;
      delete require.cache[resolvedRoute];
    }
  };
}

function makeFullRepo(overrides = {}) {
  return Object.assign({
    list:         async () => [],
    findById:     async () => null,
    create:       async () => ({}),
    assign:       async () => null,
    updateStatus: async () => null,
    complete:     async () => null
  }, overrides);
}

function handler(router, method, path) {
  return router.stack.find(l => l.route && l.route.methods[method] && l.route.path === path);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

test('maintenance: empty router without maintenanceRepo', () => {
  const router = maintenanceRouterMod.build({});
  assert.equal(router.stack.length, 0);
});

test('maintenance: non-empty router with maintenanceRepo', () => {
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo() });
  assert.ok(router.stack.length > 0);
});

// ── Authorization ────────────────────────────────────────────────────────────

test('maintenance: 403 without maintenance.create', async () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const req = makeReq({ ctx: makeCtx({ permissions: ['maintenance.read'] }) });
  const res = makeRes();
  const next = makeNext();
  requirePermission('maintenance.create')(req, res, next);
  const blocked = (res._status === 401 || res._status === 403) || next.err != null;
  assert.ok(blocked);
});

test('maintenance: 403 without maintenance.complete', async () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const req = makeReq({ ctx: makeCtx({ permissions: ['maintenance.read'] }) });
  const res = makeRes();
  const next = makeNext();
  requirePermission('maintenance.complete')(req, res, next);
  const blocked = (res._status === 401 || res._status === 403) || next.err != null;
  assert.ok(blocked);
});

// ── List ─────────────────────────────────────────────────────────────────────

test('maintenance list: 200 with data array', async () => {
  const rows = [{ id: WO_ID, title: 'Fix AC', status: 'open' }];
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ list: async () => rows }) });
  const h = handler(router, 'get', '/');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 200);
  assert.deepStrictEqual(res._body.data, rows);
  assert.equal(res._body.ok, true);
});

test('maintenance list: MAINTENANCE_PROPERTY_REQUIRED → 400', async () => {
  const err = Object.assign(new Error('prop'), { code: 'MAINTENANCE_PROPERTY_REQUIRED' });
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ list: async () => { throw err; } }) });
  const h = handler(router, 'get', '/');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'maintenance_property_required');
});

test('maintenance list: PROPERTY_ACCESS_DENIED → 403', async () => {
  const err = Object.assign(new Error('denied'), { code: 'PROPERTY_ACCESS_DENIED' });
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ list: async () => { throw err; } }) });
  const h = handler(router, 'get', '/');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'property_access_denied');
});

// ── GetById ───────────────────────────────────────────────────────────────────

test('maintenance findById: 404 when not found', async () => {
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo() });
  const h = handler(router, 'get', '/:id');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ params: { id: WO_ID } }), res, makeNext());
  assert.equal(res._status, 404);
  assert.equal(res._body.error, 'work_order_not_found');
});

test('maintenance findById: 200 when found', async () => {
  const row = { id: WO_ID, title: 'Fix AC', work_order_number: 'WO-001' };
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ findById: async () => row }) });
  const h = handler(router, 'get', '/:id');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ params: { id: WO_ID } }), res, makeNext());
  assert.equal(res._status, 200);
  assert.equal(res._body.data.id, WO_ID);
});

// ── Create ────────────────────────────────────────────────────────────────────

test('maintenance create: 400 when title missing', async () => {
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo() });
  const h = handler(router, 'post', '/');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ body: { category: 'Electrical' } }), res, makeNext());
  assert.equal(res._status, 400);
  assert.match(res._body.error, /title/);
});

test('maintenance create: stamped reporter from ctx, not body', async () => {
  let captured;
  const row = { id: WO_ID, title: 'Leaky faucet', work_order_number: 'WO-X' };
  const repo = makeFullRepo({ create: async (rec) => { captured = rec; return row; } });
  const router = maintenanceRouterMod.build({ maintenanceRepo: repo });
  const h = handler(router, 'post', '/');
  const req = makeReq({ body: { title: 'Leaky faucet', reported_by_user_id: 'evil-id' } });
  await withAuditStub(() => h.route.stack[1].handle(req, makeRes(), makeNext()));
  assert.equal(captured.reported_by_user_id, ACTOR_A);
  assert.notEqual(captured.reported_by_user_id, 'evil-id');
});

test('maintenance create: body.room accepted as asset_or_location alias', async () => {
  let captured;
  const repo = makeFullRepo({ create: async (rec) => { captured = rec; return { id: WO_ID, ...rec }; } });
  const router = maintenanceRouterMod.build({ maintenanceRepo: repo });
  const h = handler(router, 'post', '/');
  const req = makeReq({ body: { title: 'AC broken', room: 'Room 204' } });
  await withAuditStub(() => h.route.stack[1].handle(req, makeRes(), makeNext()));
  assert.equal(captured.asset_or_location, 'Room 204');
});

test('maintenance create: 201 on success', async () => {
  const row = { id: WO_ID, title: 'Fix lights', status: 'open', work_order_number: 'WO-Y' };
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ create: async () => row }) });
  const h = handler(router, 'post', '/');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ body: { title: 'Fix lights', category: 'Electrical' } }), res, makeNext()
  ));
  assert.equal(res._status, 201);
  assert.equal(res._body.data.id, WO_ID);
  assert.equal(res._body.ok, true);
});

// ── Assign ────────────────────────────────────────────────────────────────────

test('maintenance assign: 400 when assigned_to_user_id missing', async () => {
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo() });
  const h = handler(router, 'patch', '/:id/assign');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ params: { id: WO_ID }, body: {} }), res, makeNext());
  assert.equal(res._status, 400);
  assert.match(res._body.error, /assigned_to_user_id/);
});

test('maintenance assign: 404 when repo returns null', async () => {
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ assign: async () => null }) });
  const h = handler(router, 'patch', '/:id/assign');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ params: { id: WO_ID }, body: { assigned_to_user_id: ACTOR_A } }), res, makeNext()
  ));
  assert.equal(res._status, 404);
  assert.equal(res._body.error, 'work_order_not_found');
});

test('maintenance assign: 200 on success', async () => {
  const row = { id: WO_ID, status: 'assigned', assigned_to_user_id: ACTOR_A };
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ assign: async () => row }) });
  const h = handler(router, 'patch', '/:id/assign');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ params: { id: WO_ID }, body: { assigned_to_user_id: ACTOR_A } }), res, makeNext()
  ));
  assert.equal(res._status, 200);
  assert.equal(res._body.data.status, 'assigned');
});

// ── Status ────────────────────────────────────────────────────────────────────

test('maintenance updateStatus: 400 when status missing', async () => {
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo() });
  const h = handler(router, 'patch', '/:id/status');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ params: { id: WO_ID }, body: {} }), res, makeNext());
  assert.equal(res._status, 400);
  assert.match(res._body.error, /status/);
});

test('maintenance updateStatus: INVALID_STATUS → 400', async () => {
  const err = Object.assign(new Error('bad'), { code: 'INVALID_STATUS' });
  const repo = makeFullRepo({ updateStatus: async () => { throw err; } });
  const router = maintenanceRouterMod.build({ maintenanceRepo: repo });
  const h = handler(router, 'patch', '/:id/status');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ params: { id: WO_ID }, body: { status: 'junk' } }), res, makeNext()
  ));
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'invalid_status');
});

test('maintenance updateStatus: 404 when repo returns null', async () => {
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ updateStatus: async () => null }) });
  const h = handler(router, 'patch', '/:id/status');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ params: { id: WO_ID }, body: { status: 'in_progress' } }), res, makeNext()
  ));
  assert.equal(res._status, 404);
  assert.equal(res._body.error, 'work_order_not_found');
});

// ── Complete ──────────────────────────────────────────────────────────────────

test('maintenance complete: 404 when repo returns null', async () => {
  const router = maintenanceRouterMod.build({ maintenanceRepo: makeFullRepo({ complete: async () => null }) });
  const h = handler(router, 'patch', '/:id/complete');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ params: { id: WO_ID }, body: {} }), res, makeNext()
  ));
  assert.equal(res._status, 404);
  assert.equal(res._body.error, 'work_order_not_found');
});

test('maintenance complete: 200 on success with notes', async () => {
  let capturedNotes;
  const row = { id: WO_ID, status: 'completed', completed_at: new Date().toISOString() };
  const repo = makeFullRepo({ complete: async (id, ctx, opts) => { capturedNotes = opts.resolutionNotes; return row; } });
  const router = maintenanceRouterMod.build({ maintenanceRepo: repo });
  const h = handler(router, 'patch', '/:id/complete');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ params: { id: WO_ID }, body: { resolution_notes: 'Replaced part' } }), res, makeNext()
  ));
  assert.equal(res._status, 200);
  assert.equal(res._body.data.status, 'completed');
  assert.equal(capturedNotes, 'Replaced part');
});

// ── Audit aggregate type ──────────────────────────────────────────────────────

test('maintenance create: audit name and aggregateType correct', async () => {
  const auditCalls = [];
  const loaded = loadRouteWithAuditStub(
    '../src/routes/maintenance',
    async (meta, payload, ctx, work) => { auditCalls.push({ meta, payload }); return work(); }
  );
  try {
    const row = { id: WO_ID, title: 'Test', work_order_number: 'WO-Z' };
    const router = loaded.routeModule.build({ maintenanceRepo: makeFullRepo({ create: async () => row }) });
    const h = handler(router, 'post', '/');
    await h.route.stack[1].handle(makeReq({ body: { title: 'Test WO' } }), makeRes(), makeNext());
    assert.ok(auditCalls.length > 0);
    assert.equal(auditCalls[0].meta.aggregateType, 'maintenance_work_order');
    assert.equal(auditCalls[0].meta.name, 'maintenance.create');
  } finally {
    loaded.restore();
  }
});

test('maintenance complete: audit name is maintenance.complete', async () => {
  const auditCalls = [];
  const loaded = loadRouteWithAuditStub(
    '../src/routes/maintenance',
    async (meta, payload, ctx, work) => { auditCalls.push({ meta }); return work(); }
  );
  try {
    const row = { id: WO_ID, status: 'completed' };
    const router = loaded.routeModule.build({ maintenanceRepo: makeFullRepo({ complete: async () => row }) });
    const h = handler(router, 'patch', '/:id/complete');
    await h.route.stack[1].handle(makeReq({ params: { id: WO_ID }, body: {} }), makeRes(), makeNext());
    assert.ok(auditCalls.length > 0);
    assert.equal(auditCalls[0].meta.name, 'maintenance.complete');
  } finally {
    loaded.restore();
  }
});
