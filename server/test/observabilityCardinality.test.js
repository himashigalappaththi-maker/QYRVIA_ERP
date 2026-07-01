'use strict';

/**
 * Phase 34 - Metrics retention, alerting & dashboards. Proves bounded
 * cardinality (allow-list + value sanitisation + per-metric series cap with an
 * __other__ overflow bucket), DB pool + queue-depth gauges, the admin-safe
 * /metrics/summary endpoint (guarded, id/secret-free), and that the alert rules
 * file references real exported metric names.
 */

const fx = require('./_fixtures'); // sets env sentinels + LOG_LEVEL=silent
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildLabelGuard, sanitizeLabelValue, OTHER } = require('../src/observability/labelGuard');
const { buildObservabilityMetrics } = require('../src/observability/metrics');
const { buildMetricsEngine } = require('../src/platform/observability/MetricsEngine');
const { createApp } = require('../src/app');
const { buildPlatformLayer } = require('../src/platform/PlatformLayer');

const UUID = 'dddddddd-dddd-1ddd-dddd-dddddddddddd';
const freshMetrics = () => buildObservabilityMetrics({ engine: buildMetricsEngine() });

// ---- label guard -----------------------------------------------------------
test('labelGuard: allow-listed dimensions collapse unknown values to __other__', () => {
  const g = buildLabelGuard();
  assert.deepEqual(g.guard('db_queries_total', { op: 'select' }), { op: 'select' });
  assert.deepEqual(g.guard('db_queries_total', { op: 'DROP; rm -rf' }), { op: OTHER });
  assert.deepEqual(g.guard('rls_events_total', { event: 'tenant_switch' }), { event: 'tenant_switch' });
  assert.deepEqual(g.guard('rls_events_total', { event: 'totally-made-up' }), { event: OTHER });
  // status pattern: 3-digit 1xx-5xx kept, anything else -> __other__
  assert.equal(g.guard('http_requests_total', { method: 'GET', route: '/x', status: '200' }).status, '200');
  assert.equal(g.guard('http_requests_total', { method: 'get', route: '/x', status: 'NaN' }).status, OTHER);
  assert.equal(g.guard('http_requests_total', { method: 'BREW', route: '/x', status: '418' }).method, OTHER);
});

test('labelGuard: value sanitisation strips unsafe chars and overlong tokens', () => {
  assert.equal(sanitizeLabelValue('a b{c}=d,e"f'), 'a_b_c__d_e_f');
  assert.equal(sanitizeLabelValue('/api/pms/rooms/:id'), '/api/pms/rooms/:id'); // safe chars kept
  assert.equal(sanitizeLabelValue('x'.repeat(65)), null);                       // overlong -> unsafe
  // An overlong free value lands in __other__ via the guard.
  const g = buildLabelGuard();
  assert.equal(g.guard('http_request_ms', { method: 'GET', route: 'r'.repeat(200) }).route, OTHER);
});

test('labelGuard: per-metric series cap collapses free dimensions to __other__', () => {
  const g = buildLabelGuard({ maxSeriesPerMetric: 5 });
  // 5 distinct routes fit; the rest collapse (method stays fixed/allow-listed).
  for (let i = 0; i < 5; i++) {
    assert.equal(g.guard('http_request_ms', { method: 'GET', route: '/r/' + i }).route, '/r/' + i);
  }
  assert.equal(g.guard('http_request_ms', { method: 'GET', route: '/r/overflow' }).route, OTHER);
  // The fixed dimension is preserved even under collapse.
  assert.equal(g.guard('http_request_ms', { method: 'POST', route: '/r/another' }).method, 'POST');
  // Series count is bounded.
  assert.ok(g.seriesCount('http_request_ms') <= 5 + 4 /* method x __other__ combos */);
});

// ---- metrics registry: guarded recording ----------------------------------
test('metrics: a flood of distinct routes stays bounded via __other__', () => {
  const m = buildObservabilityMetrics({ engine: buildMetricsEngine(), labelGuard: buildLabelGuard({ maxSeriesPerMetric: 10 }) });
  for (let i = 0; i < 500; i++) m.httpRequest('GET', '/api/thing/' + i, 200, 1);
  const snap = m.snapshot();
  const routeSeries = Object.keys(snap.counters).filter((k) => k.startsWith('http_requests_total'));
  assert.ok(routeSeries.length <= 12, 'route series should be bounded, got ' + routeSeries.length);
  assert.ok(routeSeries.some((k) => k.includes('route=__other__')), 'expected an __other__ overflow series');
});

// ---- DB pool + queue-depth gauges ------------------------------------------
test('metrics: DB pool gauges read live from a bound pool and appear in prometheus', () => {
  const m = freshMetrics();
  m.bindPool({ totalCount: 7, idleCount: 4, waitingCount: 2 });
  const snap = m.snapshot();
  assert.deepEqual(snap.pool, { total: 7, idle: 4, waiting: 2 });
  const prom = m.prometheus();
  assert.match(prom, /qyrvia_db_pool_total 7/);
  assert.match(prom, /qyrvia_db_pool_idle 4/);
  assert.match(prom, /qyrvia_db_pool_waiting 2/);
});

test('metrics: queue-depth provider is exposed as a gauge with a safe label', () => {
  const m = freshMetrics();
  m.bindQueueDepthProvider(() => ({ channel_sync: 3, 'bad name!': 9 }));
  const snap = m.snapshot();
  assert.equal(snap.queueDepth.channel_sync, 3);
  assert.equal(snap.queueDepth['bad_name_'], 9); // sanitised key
  assert.match(m.prometheus(), /qyrvia_job_queue_depth\{queue="channel_sync"\} 3/);
});

// ---- summary (admin-UI safe) -----------------------------------------------
test('metrics: summary aggregates by class and leaks no ids/SQL/secrets', () => {
  const m = freshMetrics();
  m.bindPool({ totalCount: 5, idleCount: 5, waitingCount: 0 });
  m.httpRequest('GET', '/api/pms/rooms/' + UUID, 200, 4);
  m.httpRequest('POST', '/api/booking', 500, 9);
  m.dbQuery('select', 2);
  m.dbQuery('insert', 600, { slowBucket: 'high_gt_500ms' });
  m.rls('tenant_switch');
  m.rls('context_failure');
  m.business('reservation');

  const s = m.summary();
  assert.equal(s.http.requests_total, 2);
  assert.equal(s.http.by_status_class['2xx'], 1);
  assert.equal(s.http.by_status_class['5xx'], 1);
  assert.equal(s.http.error_ratio_5xx, 0.5);
  assert.equal(s.db.by_op.select, 1);
  assert.equal(s.db.slow.high_gt_500ms, 1);
  assert.deepEqual(s.db.pool, { total: 5, idle: 5, waiting: 0 });
  assert.equal(s.rls.tenant_switch, 1);
  assert.equal(s.rls.context_failure, 1);
  assert.equal(s.business.reservation, 1);

  // Hard guarantee: the entire summary JSON contains no raw uuid.
  assert.ok(!JSON.stringify(s).includes(UUID), 'summary leaked a raw id');
});

// ---- /api/platform/metrics/summary endpoint --------------------------------
test('GET /api/platform/metrics/summary is permission-guarded', async () => {
  const { srv, url } = await fx.listen(buildPlatformApp());
  try {
    const anon = await fx.fetchJson(url + '/api/platform/metrics/summary');
    assert.equal(anon.status, 401);

    const weak = fx.issueTestToken({ roleCodes: ['front_desk'], primaryPropertyId: UUID });
    const denied = await fx.fetchJson(url + '/api/platform/metrics/summary', { headers: fx.authHeader(weak) });
    assert.equal(denied.status, 403);

    const admin = fx.issueTestToken({ roleCodes: ['super_admin'], primaryPropertyId: UUID });
    const ok = await fx.fetchJson(url + '/api/platform/metrics/summary', { headers: fx.authHeader(admin) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.ok(ok.body.data && typeof ok.body.data.http === 'object');
    assert.ok(!JSON.stringify(ok.body.data).includes(UUID), 'summary endpoint leaked a raw id');
  } finally { srv.close(); }
});

// ---- alert rules file ------------------------------------------------------
test('prometheus alert rules reference real exported metric names', () => {
  const p = path.join(__dirname, '..', 'ops', 'prometheus', 'qyrvia_alerts.yml');
  const text = fs.readFileSync(p, 'utf8');
  for (const metric of [
    'qyrvia_db_slow_queries_total',
    'qyrvia_rls_events_total',
    'qyrvia_http_requests_total',
    'qyrvia_http_active_requests',
    'qyrvia_db_pool_waiting'
  ]) {
    assert.ok(text.includes(metric), 'alert rules missing reference to ' + metric);
  }
  // Each of the required alert scenarios is present.
  for (const alert of [
    'QyrviaSlowQueryRateHigh', 'QyrviaRlsMissingContextSpike',
    'QyrviaRlsDeniedSpike', 'QyrviaHttp5xxRatioHigh', 'QyrviaActiveRequestSaturation'
  ]) {
    assert.ok(text.includes(alert), 'alert rules missing ' + alert);
  }
});

// ---- helpers ---------------------------------------------------------------
function buildPlatformApp() {
  const repos = fx.makeFakeRepos();
  return createApp({
    db: fx.makeFakeDb(),
    identityRepo: repos.identityRepo,
    tokensRepo: repos.tokensRepo,
    platform: buildPlatformLayer({})
  });
}
