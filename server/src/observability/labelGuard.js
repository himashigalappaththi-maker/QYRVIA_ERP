'use strict';

/**
 * Metric label guard (Phase 34). Bounded-cardinality protection for the
 * observability registry. Three layers:
 *
 *   1. Value sanitisation  - every label value is coerced to a short, label-safe
 *      token; overlong or unsafe values become `__other__`. This is the last
 *      line of defence against a raw id / SQL fragment / secret accidentally
 *      reaching a metric label.
 *   2. Per-metric allow-list - known label keys are constrained to a fixed set
 *      (or a pattern); anything outside it collapses to `__other__`.
 *   3. Per-metric series cap - once a metric has accumulated `maxSeriesPerMetric`
 *      distinct label combinations, additional NEW combinations have their
 *      "free" (unbounded) dimensions collapsed to `__other__`, so the series
 *      count can never grow without bound.
 *
 * The guard never throws; on any error it falls back to the all-`__other__`
 * combination so a recording can still proceed safely.
 */

const OTHER = '__other__';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);
const DB_OPS = new Set(['select', 'insert', 'update', 'delete', 'with', 'begin', 'commit', 'rollback', 'set', 'create', 'alter', 'drop', 'truncate', 'other']);
const SLOW_BUCKETS = new Set(['warn_gt_100ms', 'high_gt_500ms', 'critical_gt_1s']);
const RLS_EVENTS = new Set(['tenant_switch', 'property_switch', 'denied', 'context_failure']);
const JOB_EVENTS = new Set(['started', 'succeeded', 'failed', 'retried']);
const BUSINESS_EVENTS = new Set(['reservation', 'checkin', 'checkout', 'invoice', 'payment', 'housekeeping', 'maintenance']);
const SECURITY_CATEGORIES = new Set(['auth', 'authz', 'db', 'api', 'infra', 'unknown']);
const STATUS_RE = /^[1-5]\d{2}$/;

// Per-metric label specs. A Set or RegExp value is a BOUNDED dimension
// (unknown -> __other__, never collapsed by the cap). '*' is a FREE dimension
// (kept as-is until the series cap is hit, then collapsed).
const ALLOW = {
  http_requests_total:   { method: HTTP_METHODS, status: STATUS_RE, route: '*' },
  http_request_ms:       { method: HTTP_METHODS, route: '*' },
  db_queries_total:      { op: DB_OPS },
  db_query_ms:           { op: DB_OPS },
  db_slow_queries_total: { bucket: SLOW_BUCKETS },
  rls_events_total:      { event: RLS_EVENTS },
  job_events_total:      { name: '*', event: JOB_EVENTS },
  job_execution_ms:      { name: '*' },
  business_events_total: { event: BUSINESS_EVENTS },
  security_events_total: { event: '*', category: SECURITY_CATEGORIES }
};

const MAX_VALUE_LEN = 64;

/** Coerce a label value to a short, label-safe token (or null if unsafe). */
function sanitizeLabelValue(v) {
  let s = String(v == null ? '' : v);
  if (s.length === 0) return null;
  if (s.length > MAX_VALUE_LEN) return null;               // overlong -> unsafe
  if (/[^\w.\-:/]/.test(s)) s = s.replace(/[^\w.\-:/]/g, '_'); // keep only label-safe chars
  return s;
}

function isFree(spec, key) {
  return !spec || !(key in spec) || spec[key] === '*';
}

function applySpec(spec, key, raw) {
  const s = sanitizeLabelValue(raw);
  if (s === null) return OTHER;
  if (spec && key in spec) {
    const rule = spec[key];
    if (rule instanceof Set) return rule.has(s) ? s : OTHER;
    if (rule instanceof RegExp) return rule.test(s) ? s : OTHER;
    // '*' free dimension - keep the sanitised value
  }
  return s;
}

function comboKey(labels) {
  return Object.keys(labels).sort().map((k) => k + '=' + labels[k]).join(',');
}

/**
 * Build a stateful guard. `maxSeriesPerMetric` bounds the distinct label
 * combinations tracked per metric before free dimensions start collapsing.
 */
function buildLabelGuard({ maxSeriesPerMetric = 250 } = {}) {
  const seen = new Map(); // metric -> Set(comboKey)

  function guard(metric, labels) {
    if (!labels || Object.keys(labels).length === 0) return labels;
    try {
      const spec = ALLOW[metric] || null;
      const out = {};
      for (const [k, raw] of Object.entries(labels)) out[k] = applySpec(spec, k, raw);

      let set = seen.get(metric);
      if (!set) { set = new Set(); seen.set(metric, set); }

      const key = comboKey(out);
      if (set.has(key)) return out;
      if (set.size < maxSeriesPerMetric) { set.add(key); return out; }

      // Cap reached: collapse free dimensions so the series count stays bounded
      // by the (small) cartesian product of the fixed dimensions.
      for (const k of Object.keys(out)) if (isFree(spec, k)) out[k] = OTHER;
      set.add(comboKey(out));
      return out;
    } catch (_) {
      // Absolute fallback: an all-__other__ shape preserves the label keys.
      const safe = {};
      for (const k of Object.keys(labels)) safe[k] = OTHER;
      return safe;
    }
  }

  function reset() { seen.clear(); }
  function seriesCount(metric) { const s = seen.get(metric); return s ? s.size : 0; }

  return { guard, reset, seriesCount, OTHER, maxSeriesPerMetric };
}

module.exports = {
  buildLabelGuard, sanitizeLabelValue, OTHER,
  ALLOW, HTTP_METHODS, DB_OPS, SLOW_BUCKETS, RLS_EVENTS, JOB_EVENTS, BUSINESS_EVENTS, SECURITY_CATEGORIES
};
