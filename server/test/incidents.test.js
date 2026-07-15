'use strict';

/**
 * Phase 59 — Incident reports: route-level unit tests.
 *
 * Tests isolation/authorization, CRUD, status transitions, audit events,
 * and protection against request-body overrides.
 */

// Env sentinels must be set before any app module is required.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';
process.env.LOG_LEVEL    = 'silent';
process.env.NODE_ENV     = 'test';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const incidentsRouterMod = require('../src/routes/incidents');

const TENANT_A = 'aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa';
const PROP_A   = 'dddddddd-dddd-1ddd-dddd-dddddddddddd';
const ACTOR_A  = 'cccccccc-cccc-1ccc-cccc-cccccccccccc';
const INC_ID   = 'eeeeeeee-eeee-1eee-eeee-eeeeeeeeeeee';

// ── Shared helpers ─────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return Object.assign({
    tenantId: TENANT_A, propertyId: PROP_A, actorId: ACTOR_A,
    requestId: 'req-test', roleCodes: ['admin'],
    permissions: [
      'incident.read', 'incident.create', 'incident.assign',
      'incident.update', 'incident.resolve'
    ]
  }, overrides);
}

function makeReq({ method = 'GET', body = {}, params = {}, query = {}, ctx } = {}) {
  return { method, body, params, query, ctx: ctx || makeCtx() };
}

function makeRes() {
  const res = {
    _status: 200, _body: null,
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

// ── Audit pipeline stub ───────────────────────────────────────────────────────
// runWithAudit must be resolvable; stub it for unit tests.
const originalModule = require('../src/audit/pipeline');
const _origRunWithAudit = originalModule.runWithAudit;

function withAuditStub(fn) {
  originalModule.runWithAudit = async (_meta, _payload, _ctx, work) => work();
  try { return fn(); }
  finally { originalModule.runWithAudit = _origRunWithAudit; }
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

// ── Wiring tests ───────────────────────────────────────────────────────────────

test('incidents: empty router without incidentRepo', () => {
  const router = incidentsRouterMod.build({});
  assert.equal(router.stack.length, 0);
});

test('incidents: non-empty router with incidentRepo', () => {
  const router = incidentsRouterMod.build({ incidentRepo: {
    list: async () => [], findById: async () => null,
    create: async () => ({}), updateStatus: async () => null
  }});
  assert.ok(router.stack.length > 0);
});

// ── 401/403 via missing/wrong permissions ─────────────────────────────────────

test('incidents: 401 without any token — requirePermission blocks', async () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const req = makeReq({ ctx: makeCtx({ permissions: [] }) });
  const res = makeRes();
  const next = makeNext();
  requirePermission('incident.read')(req, res, next);
  // With no matching permission, authorization should call next with an error or set status 401/403
  // (the real implementation uses res.status(401/403) depending on authentication state)
  // We just verify it doesn't call next without error when permissions are absent.
  const isBlocked = (res._status === 401 || res._status === 403) || (next.err != null);
  assert.ok(isBlocked, 'request without permission should be rejected');
});

test('incidents: 403 without incident.create permission on POST', async () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const req = makeReq({ ctx: makeCtx({ permissions: ['incident.read'] }) });
  const res = makeRes();
  const next = makeNext();
  requirePermission('incident.create')(req, res, next);
  const isBlocked = (res._status === 401 || res._status === 403) || (next.err != null);
  assert.ok(isBlocked, 'missing incident.create should be rejected');
});

// ── Repo delegation tests ──────────────────────────────────────────────────────

test('incidents list: returns data from incidentRepo.list', async () => {
  const rows = [{ id: INC_ID, title: 'Flood', status: 'open', tenant_id: TENANT_A }];
  const repo = { list: async () => rows, findById: async () => null,
                 create: async () => ({}), updateStatus: async () => null };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const listHandler = router.stack.find(l => l.route && l.route.methods.get && l.route.path === '/');
  assert.ok(listHandler, 'GET / handler registered');

  const req = makeReq({ query: {} });
  const res = makeRes();
  const next = makeNext();
  await listHandler.route.stack[1].handle(req, res, next);
  assert.equal(res._status, 200);
  assert.deepStrictEqual(res._body.data, rows);
  assert.equal(res._body.ok, true);
});

test('incidents list: property error surfaces as 400', async () => {
  const err = Object.assign(new Error('prop required'), { code: 'INCIDENT_PROPERTY_REQUIRED' });
  const repo = { list: async () => { throw err; }, findById: async () => null,
                 create: async () => ({}), updateStatus: async () => null };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const listHandler = router.stack.find(l => l.route && l.route.methods.get && l.route.path === '/');
  const req = makeReq({ query: {} });
  const res = makeRes();
  const next = makeNext();
  await listHandler.route.stack[1].handle(req, res, next);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'incident_property_required');
});

test('incidents list: access denied surfaces as 403', async () => {
  const err = Object.assign(new Error('denied'), { code: 'PROPERTY_ACCESS_DENIED' });
  const repo = { list: async () => { throw err; }, findById: async () => null,
                 create: async () => ({}), updateStatus: async () => null };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const listHandler = router.stack.find(l => l.route && l.route.methods.get && l.route.path === '/');
  const req = makeReq({ query: {} });
  const res = makeRes();
  const next = makeNext();
  await listHandler.route.stack[1].handle(req, res, next);
  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'property_access_denied');
});

test('incidents findById: 404 when not found', async () => {
  const repo = { list: async () => [], findById: async () => null,
                 create: async () => ({}), updateStatus: async () => null };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const getById = router.stack.find(l => l.route && l.route.methods.get && l.route.path === '/:id');
  const req = makeReq({ params: { id: INC_ID } });
  const res = makeRes();
  const next = makeNext();
  await getById.route.stack[1].handle(req, res, next);
  assert.equal(res._status, 404);
  assert.equal(res._body.error, 'incident_not_found');
});

test('incidents create: 400 when title missing', async () => {
  const repo = { list: async () => [], findById: async () => null,
                 create: async () => ({}), updateStatus: async () => null };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const postHandler = router.stack.find(l => l.route && l.route.methods.post && l.route.path === '/');
  const req = makeReq({ body: { severity: 'high' } }); // no title
  const res = makeRes();
  const next = makeNext();
  await postHandler.route.stack[1].handle(req, res, next);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /title/);
});

test('incidents create: stamped reporter from ctx, not body', async () => {
  let captured;
  const repo = {
    list: async () => [], findById: async () => null,
    create: async (rec) => { captured = rec; return { id: INC_ID, ...rec }; },
    updateStatus: async () => null
  };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const postHandler = router.stack.find(l => l.route && l.route.methods.post && l.route.path === '/');
  const req = makeReq({
    body: { title: 'Broken pipe', reported_by_user_id: 'hacker-id', severity: 'medium' }
  });
  const res = makeRes();
  const next = makeNext();
  await withAuditStub(() => postHandler.route.stack[1].handle(req, res, next));
  assert.equal(captured.reported_by_user_id, ACTOR_A, 'reporter stamped from ctx.actorId, not body');
  assert.notEqual(captured.reported_by_user_id, 'hacker-id', 'body override rejected');
});

test('incidents create: 201 on success', async () => {
  const row = { id: INC_ID, title: 'Water leak', status: 'open', incident_number: 'INC-001' };
  const repo = {
    list: async () => [], findById: async () => null,
    create: async () => row, updateStatus: async () => null
  };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const postHandler = router.stack.find(l => l.route && l.route.methods.post && l.route.path === '/');
  const req = makeReq({ body: { title: 'Water leak', category: 'Other', severity: 'low' } });
  const res = makeRes();
  const next = makeNext();
  await withAuditStub(() => postHandler.route.stack[1].handle(req, res, next));
  assert.equal(res._status, 201);
  assert.equal(res._body.data.id, INC_ID);
  assert.equal(res._body.ok, true);
});

test('incidents resolve: sets resolvedAt and status=resolved', async () => {
  let capturedUpdate;
  const row = { id: INC_ID, status: 'resolved', resolved_at: new Date().toISOString() };
  const repo = {
    list: async () => [], findById: async () => null, create: async () => ({}),
    updateStatus: async (id, ctx, opts) => { capturedUpdate = { id, opts }; return row; }
  };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const resolveHandler = router.stack.find(l => l.route && l.route.methods.patch && l.route.path === '/:id/resolve');
  const req = makeReq({ params: { id: INC_ID }, body: { action_taken: 'Repaired pipe' } });
  const res = makeRes();
  const next = makeNext();
  await withAuditStub(() => resolveHandler.route.stack[1].handle(req, res, next));
  assert.equal(capturedUpdate.opts.status, 'resolved');
  assert.ok(capturedUpdate.opts.resolvedAt, 'resolvedAt set');
});

test('incidents assign: 400 when assigned_to_user_id missing', async () => {
  const repo = { list: async () => [], findById: async () => null,
                 create: async () => ({}), updateStatus: async () => null };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const assignHandler = router.stack.find(l => l.route && l.route.methods.patch && l.route.path === '/:id/assign');
  const req = makeReq({ params: { id: INC_ID }, body: {} });
  const res = makeRes();
  const next = makeNext();
  await assignHandler.route.stack[1].handle(req, res, next);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /assigned_to_user_id/);
});

test('incidents update status: 400 on missing status', async () => {
  const repo = { list: async () => [], findById: async () => null,
                 create: async () => ({}), updateStatus: async () => null };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const statusHandler = router.stack.find(l => l.route && l.route.methods.patch && l.route.path === '/:id/status');
  const req = makeReq({ params: { id: INC_ID }, body: {} });
  const res = makeRes();
  const next = makeNext();
  await statusHandler.route.stack[1].handle(req, res, next);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /status/);
});

test('incidents update status: invalid_status from repo is 400', async () => {
  const err = Object.assign(new Error('invalid'), { code: 'INVALID_STATUS' });
  const repo = { list: async () => [], findById: async () => null, create: async () => ({}),
                 updateStatus: async () => { throw err; } };
  const router = incidentsRouterMod.build({ incidentRepo: repo });
  const statusHandler = router.stack.find(l => l.route && l.route.methods.patch && l.route.path === '/:id/status');
  const req = makeReq({ params: { id: INC_ID }, body: { status: 'junk' } });
  const res = makeRes();
  const next = makeNext();
  await withAuditStub(() => statusHandler.route.stack[1].handle(req, res, next));
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'invalid_status');
});

test('incidents: success audit entity type and ID in audit payload', async () => {
  const auditCalls = [];
  const loaded = loadRouteWithAuditStub(
    '../src/routes/incidents',
    async (meta, payload, ctx, work) => { auditCalls.push({ meta, payload }); return work(); }
  );
  try {
    const row = { id: INC_ID, title: 'Test', status: 'open', incident_number: 'INC-X' };
    const repo = { list: async () => [], findById: async () => null,
                   create: async () => row, updateStatus: async () => null };
    const router = loaded.routeModule.build({ incidentRepo: repo });
    const postHandler = router.stack.find(l => l.route && l.route.methods.post && l.route.path === '/');
    const req = makeReq({ body: { title: 'Test incident', category: 'Other', severity: 'low' } });
    const res = makeRes();
    await postHandler.route.stack[1].handle(req, res, makeNext());
    assert.ok(auditCalls.length > 0, 'audit was called');
    assert.equal(auditCalls[0].meta.aggregateType, 'incident_report');
    assert.equal(auditCalls[0].meta.name, 'incident.create');
  } finally {
    loaded.restore();
  }
});
