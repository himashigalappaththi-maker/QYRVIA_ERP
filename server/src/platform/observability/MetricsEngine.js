'use strict';

/**
 * MetricsEngine (Phase 18) - deterministic counters + timing aggregates
 * (request counts, per-module latency, revenue/audit/booking throughput).
 */

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function buildMetricsEngine() {
  const counters = new Map();
  const timings = new Map();   // key -> { count, total, max, min }

  function keyOf(name, labels) {
    if (!labels || Object.keys(labels).length === 0) return name;
    return name + '{' + Object.keys(labels).sort().map((k) => k + '=' + labels[k]).join(',') + '}';
  }

  return {
    increment(name, by = 1, labels) { const k = keyOf(name, labels); counters.set(k, (counters.get(k) || 0) + by); return counters.get(k); },
    timing(name, ms, labels) {
      const k = keyOf(name, labels);
      const t = timings.get(k) || { count: 0, total: 0, max: 0, min: Infinity };
      t.count += 1; t.total += ms; t.max = Math.max(t.max, ms); t.min = Math.min(t.min, ms);
      timings.set(k, t); return t;
    },
    snapshot() {
      const c = {}; for (const [k, v] of counters) c[k] = v;
      const t = {}; for (const [k, v] of timings) t[k] = { count: v.count, total: round2(v.total), avg: round2(v.total / v.count), max: round2(v.max), min: round2(v.min === Infinity ? 0 : v.min) };
      return { counters: c, timings: t };
    },
    reset() { counters.clear(); timings.clear(); }
  };
}

module.exports = { buildMetricsEngine };
