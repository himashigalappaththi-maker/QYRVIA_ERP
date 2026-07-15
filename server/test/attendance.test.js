'use strict';

/**
 * Phase 59 — Attendance events: route-level unit tests.
 *
 * Covers check-in/check-out, duplicate prevention, no-open-checkin,
 * coordinate validation, self-view isolation, management view, tenant isolation.
 */

// Env sentinels must be set before any app module is required.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';
process.env.LOG_LEVEL    = 'silent';
process.env.NODE_ENV     = 'test';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const attendanceRouterMod = require('../src/routes/attendance');

const TENANT_A = 'aaaaaaaa-aaaa-1aaa-aaaa-aaaaaaaaaaaa';
const PROP_A   = 'dddddddd-dddd-1ddd-dddd-dddddddddddd';
const ACTOR_A  = 'cccccccc-cccc-1ccc-cccc-cccccccccccc';
const EVT_ID   = '11111111-1111-1111-1111-111111111111';

function makeCtx(overrides = {}) {
  return Object.assign({
    tenantId: TENANT_A, propertyId: PROP_A, actorId: ACTOR_A,
    requestId: 'req-test', roleCodes: ['admin'],
    permissions: ['attendance.record', 'attendance.read', 'attendance.manage']
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
    getOpenCheckIn: async () => null,
    recordEvent:    async () => ({ id: EVT_ID, event_type: 'check_in' }),
    listMyEvents:   async () => [],
    listAllEvents:  async () => [],
    getStatus:      async () => ({ status: 'no_events', open_check_in: null, latest_event: null })
  }, overrides);
}

function handler(router, method, path) {
  return router.stack.find(l => l.route && l.route.methods[method] && l.route.path === path);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

test('attendance: empty router without attendanceRepo', () => {
  const router = attendanceRouterMod.build({});
  assert.equal(router.stack.length, 0);
});

test('attendance: non-empty router with attendanceRepo', () => {
  const router = attendanceRouterMod.build({ attendanceRepo: makeFullRepo() });
  assert.ok(router.stack.length > 0);
});

// ── Authorization ────────────────────────────────────────────────────────────

test('attendance: 403 without attendance.record', async () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const req = makeReq({ ctx: makeCtx({ permissions: ['attendance.read'] }) });
  const res = makeRes();
  const next = makeNext();
  requirePermission('attendance.record')(req, res, next);
  const blocked = (res._status === 401 || res._status === 403) || next.err != null;
  assert.ok(blocked);
});

test('attendance: 403 without attendance.manage on GET /events', async () => {
  const { requirePermission } = require('../src/middleware/authorization');
  const req = makeReq({ ctx: makeCtx({ permissions: ['attendance.read'] }) });
  const res = makeRes();
  const next = makeNext();
  requirePermission('attendance.manage')(req, res, next);
  const blocked = (res._status === 401 || res._status === 403) || next.err != null;
  assert.ok(blocked);
});

// ── event_type validation ─────────────────────────────────────────────────────

test('attendance POST /events: 400 when event_type missing', async () => {
  const router = attendanceRouterMod.build({ attendanceRepo: makeFullRepo() });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ body: {} }), res, makeNext());
  assert.equal(res._status, 400);
  assert.match(res._body.error, /event_type/);
});

test('attendance POST /events: 400 when event_type is invalid string', async () => {
  const router = attendanceRouterMod.build({ attendanceRepo: makeFullRepo() });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ body: { event_type: 'lunch_break' } }), res, makeNext());
  assert.equal(res._status, 400);
  assert.match(res._body.error, /event_type/);
});

// ── Coordinate validation ─────────────────────────────────────────────────────

test('attendance POST /events: 400 on invalid latitude > 90', async () => {
  const router = attendanceRouterMod.build({ attendanceRepo: makeFullRepo() });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(
    makeReq({ body: { event_type: 'check_in', latitude: 91.0, longitude: 80.0 } }), res, makeNext()
  );
  assert.equal(res._status, 400);
  assert.match(res._body.error, /latitude/);
});

test('attendance POST /events: 400 on invalid longitude < -180', async () => {
  const router = attendanceRouterMod.build({ attendanceRepo: makeFullRepo() });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(
    makeReq({ body: { event_type: 'check_in', latitude: 6.9, longitude: -181 } }), res, makeNext()
  );
  assert.equal(res._status, 400);
  assert.match(res._body.error, /longitude/);
});

test('attendance POST /events: 400 on negative accuracy_meters', async () => {
  const router = attendanceRouterMod.build({ attendanceRepo: makeFullRepo() });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(
    makeReq({ body: { event_type: 'check_in', accuracy_meters: -5 } }), res, makeNext()
  );
  assert.equal(res._status, 400);
  assert.match(res._body.error, /accuracy_meters/);
});

test('attendance POST /events: valid coords accepted', async () => {
  let captured;
  const repo = makeFullRepo({ recordEvent: async (rec) => { captured = rec; return { id: EVT_ID, ...rec }; } });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ body: { event_type: 'check_in', latitude: 6.9271, longitude: 79.8612, accuracy_meters: 5 } }),
    res, makeNext()
  ));
  assert.equal(res._status, 201);
  assert.ok(Math.abs(captured.latitude - 6.9271) < 0.0001);
  assert.ok(Math.abs(captured.longitude - 79.8612) < 0.0001);
});

// ── Duplicate check-in prevention ─────────────────────────────────────────────

test('attendance check_in: 409 open_checkin_exists when open check-in found', async () => {
  const openEvent = { id: EVT_ID, event_type: 'check_in' };
  const repo = makeFullRepo({ getOpenCheckIn: async () => openEvent });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ body: { event_type: 'check_in' } }), res, makeNext());
  assert.equal(res._status, 409);
  assert.equal(res._body.error, 'open_checkin_exists');
});

// ── Checkout without open check-in ───────────────────────────────────────────

test('attendance check_out: 409 no_open_checkin when no open check-in', async () => {
  const repo = makeFullRepo({ getOpenCheckIn: async () => null });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ body: { event_type: 'check_out' } }), res, makeNext());
  assert.equal(res._status, 409);
  assert.equal(res._body.error, 'no_open_checkin');
});

// ── user_id stamped from ctx ──────────────────────────────────────────────────

test('attendance: user_id stamped from ctx.actorId, not body', async () => {
  let captured;
  const repo = makeFullRepo({
    getOpenCheckIn: async () => null,
    recordEvent:    async (rec) => { captured = rec; return { id: EVT_ID, ...rec }; }
  });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'post', '/events');
  const req = makeReq({ body: { event_type: 'check_in', user_id: 'hacker-id' } });
  await withAuditStub(() => h.route.stack[1].handle(req, makeRes(), makeNext()));
  assert.equal(captured.user_id, ACTOR_A, 'user_id must come from ctx.actorId');
  assert.notEqual(captured.user_id, 'hacker-id', 'body user_id must be ignored');
});

// ── Successful check-in ───────────────────────────────────────────────────────

test('attendance check_in: 201 on success', async () => {
  const row = { id: EVT_ID, event_type: 'check_in', user_id: ACTOR_A };
  const repo = makeFullRepo({
    getOpenCheckIn: async () => null,
    recordEvent:    async () => row
  });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ body: { event_type: 'check_in', source: 'manual' } }), res, makeNext()
  ));
  assert.equal(res._status, 201);
  assert.equal(res._body.data.id, EVT_ID);
  assert.equal(res._body.ok, true);
});

// ── Successful check-out ──────────────────────────────────────────────────────

test('attendance check_out: 201 when open check-in exists', async () => {
  const openEvent = { id: 'prev-id', event_type: 'check_in' };
  const outRow = { id: EVT_ID, event_type: 'check_out', user_id: ACTOR_A };
  const repo = makeFullRepo({
    getOpenCheckIn: async () => openEvent,
    recordEvent:    async () => outRow
  });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'post', '/events');
  const res = makeRes();
  await withAuditStub(() => h.route.stack[1].handle(
    makeReq({ body: { event_type: 'check_out' } }), res, makeNext()
  ));
  assert.equal(res._status, 201);
  assert.equal(res._body.data.event_type, 'check_out');
});

// ── Self-view (GET /events/my) ────────────────────────────────────────────────

test('attendance GET /events/my: 200 with own events', async () => {
  const rows = [{ id: EVT_ID, event_type: 'check_in', user_id: ACTOR_A }];
  const repo = makeFullRepo({ listMyEvents: async () => rows });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/events/my');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 200);
  assert.deepStrictEqual(res._body.data, rows);
  assert.equal(res._body.ok, true);
});

test('attendance GET /events/my: property error → 400', async () => {
  const err = Object.assign(new Error('prop'), { code: 'ATTENDANCE_PROPERTY_REQUIRED' });
  const repo = makeFullRepo({ listMyEvents: async () => { throw err; } });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/events/my');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'attendance_property_required');
});

// ── Management view (GET /events) ─────────────────────────────────────────────

test('attendance GET /events: 200 for management view', async () => {
  const rows = [
    { id: EVT_ID, event_type: 'check_in', user_id: ACTOR_A },
    { id: '22222222-2222-2222-2222-222222222222', event_type: 'check_in', user_id: 'other-user' }
  ];
  const repo = makeFullRepo({ listAllEvents: async () => rows });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 200);
  assert.equal(res._body.data.length, 2, 'management view sees all users');
});

test('attendance GET /events: access denied → 403', async () => {
  const err = Object.assign(new Error('denied'), { code: 'PROPERTY_ACCESS_DENIED' });
  const repo = makeFullRepo({ listAllEvents: async () => { throw err; } });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/events');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'property_access_denied');
});

// ── Audit ─────────────────────────────────────────────────────────────────────

test('attendance: audit name and aggregateType', async () => {
  const auditCalls = [];
  const loaded = loadRouteWithAuditStub(
    '../src/routes/attendance',
    async (meta, payload, ctx, work) => { auditCalls.push({ meta, payload }); return work(); }
  );
  try {
    const repo = makeFullRepo({
      getOpenCheckIn: async () => null,
      recordEvent:    async () => ({ id: EVT_ID, event_type: 'check_in' })
    });
    const router = loaded.routeModule.build({ attendanceRepo: repo });
    const h = handler(router, 'post', '/events');
    await h.route.stack[1].handle(
      makeReq({ body: { event_type: 'check_in' } }), makeRes(), makeNext()
    );
    assert.ok(auditCalls.length > 0);
    assert.equal(auditCalls[0].meta.name, 'attendance.record');
    assert.equal(auditCalls[0].meta.aggregateType, 'attendance_event');
  } finally {
    loaded.restore();
  }
});

// ── No background/continuous tracking ─────────────────────────────────────────

test('attendance: no continuous tracking routes exist', () => {
  const router = attendanceRouterMod.build({ attendanceRepo: makeFullRepo() });
  const paths = router.stack
    .filter(l => l.route)
    .map(l => ({ method: Object.keys(l.route.methods)[0], path: l.route.path }));

  // Forbidden continuous-tracking routes must not exist
  const forbidden = ['/track', '/location', '/ping', '/heartbeat', '/history', '/stream', '/live'];
  for (const f of forbidden) {
    const found = paths.find(r => r.path.includes(f));
    assert.ok(!found, `Forbidden continuous-tracking route found: ${f}`);
  }
  // Permitted route prefixes: /events (history/record) and /status (authoritative read)
  const allowed = ['/events', '/status'];
  for (const r of paths) {
    const ok = allowed.some(pfx => r.path.startsWith(pfx));
    assert.ok(ok, `Unexpected route path: ${r.path}`);
  }
});

// ── GET /status/my ────────────────────────────────────────────────────────────

test('attendance GET /status/my: no events → no_events', async () => {
  const repo = makeFullRepo({
    getStatus: async () => ({ status: 'no_events', open_check_in: null, latest_event: null })
  });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/status/my');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 200);
  assert.equal(res._body.data.status, 'no_events');
  assert.equal(res._body.data.open_check_in, null);
  assert.equal(res._body.data.latest_event, null);
});

test('attendance GET /status/my: open check_in → checked_in', async () => {
  const openCI = { id: EVT_ID, event_at: '2026-07-15T08:00:00Z', source: 'manual' };
  const latest = { id: EVT_ID, event_type: 'check_in', event_at: '2026-07-15T08:00:00Z', source: 'manual' };
  const repo = makeFullRepo({
    getStatus: async () => ({ status: 'checked_in', open_check_in: openCI, latest_event: latest })
  });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/status/my');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 200);
  assert.equal(res._body.data.status, 'checked_in');
  assert.ok(res._body.data.open_check_in, 'open_check_in populated');
  assert.equal(res._body.data.open_check_in.id, EVT_ID);
});

test('attendance GET /status/my: last event check_out, no open → checked_out', async () => {
  const latest = { id: EVT_ID, event_type: 'check_out', event_at: '2026-07-15T17:00:00Z', source: 'manual' };
  const repo = makeFullRepo({
    getStatus: async () => ({ status: 'checked_out', open_check_in: null, latest_event: latest })
  });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/status/my');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 200);
  assert.equal(res._body.data.status, 'checked_out');
  assert.equal(res._body.data.open_check_in, null);
  assert.equal(res._body.data.latest_event.event_type, 'check_out');
});

test('attendance GET /status/my: user isolated — ctx.actorId stamped server-side', async () => {
  let capturedCtx;
  const repo = makeFullRepo({
    getStatus: async (ctx) => { capturedCtx = ctx; return { status: 'no_events', open_check_in: null, latest_event: null }; }
  });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/status/my');
  const ctx = makeCtx({ actorId: ACTOR_A });
  await h.route.stack[1].handle(makeReq({ ctx, query: { user_id: 'hacker-id' } }), makeRes(), makeNext());
  assert.equal(capturedCtx.actorId, ACTOR_A, 'repo receives actorId from ctx, not query');
});

test('attendance GET /status/my: property error → 400', async () => {
  const err = Object.assign(new Error('prop'), { code: 'ATTENDANCE_PROPERTY_REQUIRED' });
  const repo = makeFullRepo({ getStatus: async () => { throw err; } });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/status/my');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'attendance_property_required');
});

test('attendance GET /status/my: access denied → 403', async () => {
  const err = Object.assign(new Error('denied'), { code: 'PROPERTY_ACCESS_DENIED' });
  const repo = makeFullRepo({ getStatus: async () => { throw err; } });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/status/my');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  assert.equal(res._status, 403);
  assert.equal(res._body.error, 'property_access_denied');
});

test('attendance GET /status/my: no coordinates in response', async () => {
  const openCI = { id: EVT_ID, event_at: '2026-07-15T08:00:00Z', source: 'manual' };
  const latest = { id: EVT_ID, event_type: 'check_in', event_at: '2026-07-15T08:00:00Z', source: 'manual' };
  const repo = makeFullRepo({
    getStatus: async () => ({ status: 'checked_in', open_check_in: openCI, latest_event: latest })
  });
  const router = attendanceRouterMod.build({ attendanceRepo: repo });
  const h = handler(router, 'get', '/status/my');
  const res = makeRes();
  await h.route.stack[1].handle(makeReq({ query: {} }), res, makeNext());
  const data = res._body.data;
  assert.ok(!('latitude' in (data.open_check_in || {})), 'latitude must not appear in open_check_in');
  assert.ok(!('longitude' in (data.open_check_in || {})), 'longitude must not appear in open_check_in');
  assert.ok(!('latitude' in (data.latest_event || {})), 'latitude must not appear in latest_event');
});
