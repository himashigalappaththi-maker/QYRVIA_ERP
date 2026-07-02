'use strict';

/**
 * Slow query detection (Phase 32). Classifies query durations into
 * >100ms / >500ms / >1s buckets and logs a structured record with a SQL HASH
 * (never the SQL text or parameters), duration, tenant, property and caller.
 * Sensitive data is never logged.
 */

const crypto = require('crypto');
const { logFields } = require('./correlation');

const T_WARN = 100, T_HIGH = 500, T_CRIT = 1000;

function classify(ms) {
  if (ms >= T_CRIT) return 'critical_gt_1s';
  if (ms >= T_HIGH) return 'high_gt_500ms';
  if (ms >= T_WARN) return 'warn_gt_100ms';
  return null;
}

/** Stable hash of the query SHAPE (whitespace-normalised); no literals/params. */
function sqlHash(sql) {
  const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function buildSlowQueryDetector({ logger, metrics } = {}) {
  function record({ sql, ms, caller } = {}) {
    const bucket = classify(ms);
    if (!bucket) return null;
    const f = logFields();
    const rec = {
      evt: 'db.slow_query', bucket, duration_ms: Math.round(ms * 100) / 100,
      sql_hash: sqlHash(sql), caller: caller || null,
      tenant_id: f.tenant_id, property_id: f.property_id,
      correlation_id: f.correlation_id, request_id: f.request_id
    };
    if (logger) logger[bucket === 'warn_gt_100ms' ? 'info' : 'warn'](rec, 'slow query');
    if (metrics && metrics.dbQuery) metrics.dbQuery('slow', ms, { slowBucket: bucket });
    return rec;
  }

  /** Wrap an async query fn; times it and records if slow. */
  async function instrument(fn, { sql, caller } = {}) {
    const t0 = process.hrtime.bigint();
    try { return await fn(); }
    finally { record({ sql, caller, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); }
  }

  return { classify, sqlHash, record, instrument, thresholds: { T_WARN, T_HIGH, T_CRIT } };
}

module.exports = { buildSlowQueryDetector, classify, sqlHash };
