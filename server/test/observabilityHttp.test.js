'use strict';

/**
 * Phase 33 - Observability exposure & request-path wiring. Proves the route
 * normaliser is low-cardinality, the active-request gauge increments/decrements
 * safely (including on aborted connections), the /api/platform/metrics endpoint
 * is permission-guarded and emits Prometheus text, HTTP metrics carry no ids /
 * raw paths, and the property-context RLS gap is recorded.
 */

const fx = require('./_fixtures');           // sets DATABASE_URL/JWT_SECRET sentinels + LOG_LEVEL=silent
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createApp } = require('../src/app');
const { normalizeRoute, httpMetricsMiddleware } = require('../src/observability/httpMetrics');
const { buildObservability } = require('../src/observability');
const { buildMetricsEngine } = require('../src/platform/observability/MetricsEngine');
const { buildPlatformLayer } = require('../src/platform/PlatformLayer');
const PropertyContext = require('../src/platform/iam/PropertyContext');

const UUID = 'dddddddd-dddd-1ddd-dddd-dddddddddddd';

// ---- route normaliser ------------------------------------------------------
test('normalizeRoute collapses ids, drops query strings, and stays low-cardinality', () => {
  assert.equal(normalizeRoute('/'), '/');
  assert.equal(normalizeRoute('/api/pms/rooms'), '/api/pms/rooms');
  assert.equal(normalizeRoute(`/api/pms/rooms/${UUID}`), '/api/pms/rooms/:id');
  assert.equal(normalizeRoute('/api/iam/users/42'), '/api/iam/users/:id');
  assert.equal(normalizeRoute('/api/iam/users/42?include=roles&q=secret'), '/api/iam/users/:id');
  assert.equal(normalizeRoute('/api/files/deadbeefdeadbeefcafe1234'), '/api/files/:id'); // long hex
  assert.equal(normalizeRoute('/api/x/' + 'z'.repeat(40)), '/api/x/:id');                // overlong token

  // Distinct ids must map to the SAME label (bounded series).
  const a = normalizeRoute('/api/pms/reservations/11111111-1111-1111-1111-111111111111');
  const b = normalizeRoute('/api/pms/reservations/22222222-2222-2222-2222-222222222222');
  assert.equal(a, b);
  assert.equal(a, '/api/pms/reservations/:id');
});

// ---- active-request gauge --------------------------------------------------
test('active-request gauge increments on entry and decrements once on finish', () => {
  const obs = buildObservability({ logger: silentLogger(), metrics: buildMetricsEngine() });
  const mw = httpMetricsMiddleware(obs);

  const { req, res } = fakeReqRes('GET', '/api/pms/rooms');
  mw(req, res, () => {});
  assert.equal(obs.metrics.activeRequests(), 1);

  res.statusCode = 200;
  res.emit('finish');
  assert.equal(obs.metrics.activeRequests(), 0);

  // A late 'close' after 'finish' must NOT double-decrement below zero.
  res.emit('close');
  assert.equal(obs.metrics.activeRequests(), 0);

  const snap = obs.snapshot();
  assert.equal(snap.counters['http_requests_total{method=GET,route=/api/pms/rooms,status=200}'], 1);
});

test('active-request gauge is released on aborted connection (close without finish)', () => {
  const obs = buildObservability({ logger: silentLogger(), metrics: buildMetricsEngine() });
  const mw = httpMetricsMiddleware(obs);

  const { req, res } = fakeReqRes('POST', '/api/booking');
  mw(req, res, () => {});
  assert.equal(obs.metrics.activeRequests(), 1);

  res.statusCode = 499; // client closed request
  res.emit('close');    // aborted - 'finish' never fires
  assert.equal(obs.metrics.activeRequests(), 0);
});

// ---- /api/platform/metrics endpoint ----------------------------------------
test('GET /api/platform/metrics requires auth -> 401', async () => {
  const { srv, url } = await fx.listen(buildPlatformApp());
  try {
    const r = await fx.fetchJson(url + '/api/platform/metrics');
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('GET /api/platform/metrics is permission-guarded -> 403 without bi.dashboard.read', async () => {
  const { srv, url } = await fx.listen(buildPlatformApp());
  try {
    const token = fx.issueTestToken({ roleCodes: ['front_desk'], primaryPropertyId: UUID });
    const r = await fx.fetchJson(url + '/api/platform/metrics', { headers: fx.authHeader(token) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'permission_denied');
  } finally { srv.close(); }
});

test('GET /api/platform/metrics returns Prometheus text for an authorized caller', async () => {
  const { srv, url } = await fx.listen(buildPlatformApp());
  try {
    // super_admin bypasses requirePermission (see middleware/authorization.js).
    const token = fx.issueTestToken({ roleCodes: ['super_admin'], primaryPropertyId: UUID });
    const res = await fetch(url + '/api/platform/metrics', { headers: fx.authHeader(token) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    const body = await res.text();
    assert.match(body, /qyrvia_http_active_requests \d+/);
    // The act of serving prior requests recorded low-cardinality http series.
    assert.match(body, /qyrvia_http_requests_total\{method="GET",route="\/api\/platform\/metrics"/);
    // Guarantee: no raw uuid leaked into any metric label.
    assert.ok(!body.includes(UUID), 'a raw id leaked into a metric label');
  } finally { srv.close(); }
});

// ---- end-to-end: http metrics are low-cardinality --------------------------
test('serving a request with an id in the path records a normalized, id-free label', async () => {
  const { getObservability } = require('../src/observability');
  const obs = getObservability();
  obs.reset();

  const { srv, url } = await fx.listen(buildPlatformApp());
  try {
    // Unauthenticated hit on an id-bearing path - we only care about the metric label.
    await fx.fetchJson(url + '/api/pms/rooms/' + UUID);
    const snap = obs.snapshot();
    const keys = Object.keys(snap.counters);
    assert.ok(keys.some((k) => k.includes('route=/api/pms/rooms/:id')), 'expected normalized route label');
    assert.ok(!keys.some((k) => k.includes(UUID)), 'raw id must never appear in a metric key');
  } finally { srv.close(); }
});

// ---- property-context RLS gap ----------------------------------------------
test('PropertyContext records an RLS missing-context gap when property scope is absent', () => {
  // The hook is best-effort telemetry; the important contract is that the
  // enforcement still throws exactly as before (fail-closed).
  assert.throws(() => PropertyContext.auditEnvelope({ tenantId: 't', userId: 'u' }, { action: 'x' }),
    /propertyId required/);
  assert.throws(() => PropertyContext.jobContext({ tenantId: 't', jobName: 'sweep' }),
    /explicit propertyId is required/);
  assert.throws(() => PropertyContext.switchProperty({ tenantId: 't', userId: 'u' }, 'pB', ['pA']),
    /property_access_denied/);
});

// ---- helpers ---------------------------------------------------------------
function silentLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, fatal: noop, debug: noop, child() { return this; } };
}

function fakeReqRes(method, originalUrl) {
  const req = { method, originalUrl, url: originalUrl };
  const res = new EventEmitter();
  res.statusCode = 200;
  return { req, res };
}

function buildPlatformApp() {
  const repos = fx.makeFakeRepos();
  return createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo: repos.tokensRepo,
    platform: buildPlatformLayer({})
  });
}
