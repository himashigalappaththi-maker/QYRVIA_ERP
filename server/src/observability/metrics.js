'use strict';

/**
 * Observability metrics (Phase 32, hardened in Phase 34). A process-wide
 * registry (built on the existing MetricsEngine) with domain helpers for HTTP,
 * DB, RLS, jobs and business events, plus a Prometheus-style text exposition.
 *
 * Phase 34: every labelled recording is routed through a bounded-cardinality
 * label guard (allow-list + value sanitisation + per-metric series cap with an
 * `__other__` overflow bucket), and the exposition adds DB pool gauges
 * (total/idle/waiting) and job/scheduler queue-depth gauges. Labels remain
 * low-cardinality and never carry raw ids, SQL text/params, or secrets.
 */

const { buildMetricsEngine } = require('../platform/observability/MetricsEngine');
const { buildLabelGuard, sanitizeLabelValue } = require('./labelGuard');

function buildObservabilityMetrics({ engine, labelGuard } = {}) {
  const m = engine || buildMetricsEngine();
  const guard = labelGuard || buildLabelGuard();
  let activeRequests = 0;

  // Guarded label helper - all labelled writes go through here.
  const g = (metric, labels) => guard.guard(metric, labels);

  /** Live DB pool snapshot from a bound pg Pool (gauge semantics), else last set. */
  function readPool() {
    const ref = m._poolRef;
    if (ref) {
      return {
        total: numOrNull(ref.totalCount),
        idle: numOrNull(ref.idleCount),
        waiting: numOrNull(ref.waitingCount)
      };
    }
    return m._pool || null;
  }

  /** Merged queue-depth map: statically set depths + an optional live provider. */
  function readQueueDepth() {
    const base = Object.assign({}, m._queueDepth || {});
    if (typeof m._queueProvider === 'function') {
      try { Object.assign(base, m._queueProvider() || {}); } catch (_) { /* ignore */ }
    }
    const out = {};
    for (const [q, d] of Object.entries(base)) {
      const name = sanitizeLabelValue(q) || 'unknown';
      const depth = Number(d);
      if (Number.isFinite(depth)) out[name] = depth;
    }
    return out;
  }

  function snapshot() {
    return Object.assign(m.snapshot(), {
      activeRequests,
      pool: readPool(),
      queueDepth: readQueueDepth()
    });
  }

  function prometheus() {
    const s = m.snapshot();
    const lines = [];
    for (const [k, v] of Object.entries(s.counters)) lines.push(metricLine(k, '', v));
    for (const [k, v] of Object.entries(s.timings)) {
      // Suffix attaches to the metric NAME (before labels) per Prometheus
      // convention - keys carry their labels as `name{a=b}`.
      lines.push(metricLine(k, '_count', v.count));
      lines.push(metricLine(k, '_avg_ms', v.avg));
      lines.push(metricLine(k, '_max_ms', v.max));
    }
    lines.push('qyrvia_http_active_requests ' + activeRequests);

    // DB pool gauges (Phase 34).
    const pool = readPool();
    if (pool) {
      if (pool.total != null) lines.push('qyrvia_db_pool_total ' + pool.total);
      if (pool.idle != null) lines.push('qyrvia_db_pool_idle ' + pool.idle);
      if (pool.waiting != null) lines.push('qyrvia_db_pool_waiting ' + pool.waiting);
    }
    // Job/scheduler queue-depth gauges (Phase 34).
    for (const [q, d] of Object.entries(readQueueDepth())) {
      lines.push('qyrvia_job_queue_depth{queue="' + q + '"} ' + d);
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Admin-UI-safe aggregated JSON. Derived purely from the (already
   * low-cardinality, id-free) registry; never carries raw ids, SQL, or secrets.
   */
  function summary() {
    const s = m.snapshot();
    const c = s.counters;

    const httpTotal = sumByName(c, 'http_requests_total');
    const httpByStatusClass = bucketStatusClass(sumLabel(c, 'http_requests_total', 'status'));
    const http5xx = httpByStatusClass['5xx'] || 0;

    return {
      active_requests: activeRequests,
      http: {
        requests_total: httpTotal,
        by_status_class: httpByStatusClass,
        error_ratio_5xx: httpTotal > 0 ? round4(http5xx / httpTotal) : 0
      },
      db: {
        queries_total: sumByName(c, 'db_queries_total'),
        by_op: sumLabel(c, 'db_queries_total', 'op'),
        slow: sumLabel(c, 'db_slow_queries_total', 'bucket'),
        pool: readPool()
      },
      rls: sumLabel(c, 'rls_events_total', 'event'),
      jobs: {
        events: sumLabel(c, 'job_events_total', 'event'),
        queue_depth: readQueueDepth()
      },
      business: sumLabel(c, 'business_events_total', 'event'),
      security: {
        total: sumByName(c, 'security_events_total'),
        by_category: sumLabel(c, 'security_events_total', 'category')
      }
    };
  }

  return {
    engine: m,
    guard,
    // ---- HTTP ----
    httpRequest(method, route, status, ms) {
      m.increment('http_requests_total', 1, g('http_requests_total', { method, route, status: String(status) }));
      m.timing('http_request_ms', ms, g('http_request_ms', { method, route }));
    },
    httpActiveInc() { activeRequests++; m.increment('http_active_requests_started', 1); return activeRequests; },
    httpActiveDec() { activeRequests = Math.max(0, activeRequests - 1); return activeRequests; },
    activeRequests() { return activeRequests; },
    // ---- DB ----
    dbQuery(op, ms, { slowBucket } = {}) {
      m.increment('db_queries_total', 1, g('db_queries_total', { op }));
      m.timing('db_query_ms', ms, g('db_query_ms', { op }));
      if (slowBucket) m.increment('db_slow_queries_total', 1, g('db_slow_queries_total', { bucket: slowBucket }));
    },
    dbTransaction(ms) { m.timing('db_transaction_ms', ms); },
    dbPool({ total, idle, waiting } = {}) { m._pool = { total, idle, waiting }; },
    bindPool(pool) { m._poolRef = pool; return this; },
    // ---- RLS ----
    rls(event) { m.increment('rls_events_total', 1, g('rls_events_total', { event })); }, // tenant_switch|property_switch|denied|context_failure
    // ---- Jobs ----
    job(name, event, ms) {
      m.increment('job_events_total', 1, g('job_events_total', { name, event })); // started|succeeded|failed|retried
      if (ms != null) m.timing('job_execution_ms', ms, g('job_execution_ms', { name }));
    },
    jobQueueDepth(queue, depth) { m._queueDepth = Object.assign(m._queueDepth || {}, { [queue]: depth }); },
    bindQueueDepthProvider(fn) { m._queueProvider = fn; return this; },
    // ---- Business ----
    business(event) { m.increment('business_events_total', 1, g('business_events_total', { event })); }, // reservation|checkin|checkout|invoice|payment|housekeeping|maintenance
    // ---- exposition ----
    snapshot,
    prometheus,
    summary,
    reset() { m.reset(); guard.reset(); activeRequests = 0; m._pool = null; m._queueDepth = {}; }
  };
}

function numOrNull(n) { return (typeof n === 'number' && Number.isFinite(n)) ? n : null; }
function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

/** Parse a registry key `name{a=b,c=d}` into { name, labels }. */
function parseKey(key) {
  const mt = key.match(/^([^{]+)(?:\{(.*)\})?$/);
  if (!mt) return { name: key, labels: {} };
  const labels = {};
  if (mt[2]) {
    for (const part of mt[2].split(',')) {
      const i = part.indexOf('=');
      if (i > 0) labels[part.slice(0, i)] = part.slice(i + 1);
    }
  }
  return { name: mt[1], labels };
}

/** Sum every series belonging to a metric name. */
function sumByName(counters, name) {
  let total = 0;
  for (const [k, v] of Object.entries(counters)) if (parseKey(k).name === name) total += v;
  return total;
}

/** Sum a metric grouped by one label value -> { value: total }. */
function sumLabel(counters, name, labelKey) {
  const out = {};
  for (const [k, v] of Object.entries(counters)) {
    const p = parseKey(k);
    if (p.name !== name) continue;
    const val = p.labels[labelKey] || 'unknown';
    out[val] = (out[val] || 0) + v;
  }
  return out;
}

/** Collapse a { status: count } map into HTTP status classes. */
function bucketStatusClass(byStatus) {
  const out = {};
  for (const [status, n] of Object.entries(byStatus)) {
    const cls = /^[1-5]\d{2}$/.test(status) ? status[0] + 'xx' : 'other';
    out[cls] = (out[cls] || 0) + n;
  }
  return out;
}

function metricLine(key, suffix, val) {
  // key like name{a=b,c=d} -> qyrvia_name<suffix>{a="b",c="d"}
  const mt = key.match(/^([^{]+)(\{.*\})?$/);
  const name = 'qyrvia_' + mt[1] + (suffix || '');
  let labels = '';
  if (mt[2]) labels = '{' + mt[2].slice(1, -1).split(',').map((p) => { const [k, ...r] = p.split('='); return k + '="' + r.join('=') + '"'; }).join(',') + '}';
  return name + labels + ' ' + val;
}

module.exports = { buildObservabilityMetrics };
