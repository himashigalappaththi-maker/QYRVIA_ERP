'use strict';

/**
 * Observability composition root (Phase 32). A single process-wide handle that
 * stitches together the logger, the low-cardinality metrics registry, the
 * slow-query detector (LOG only - metrics flow through the single registry path
 * so nothing is double-counted) and the security-event emitter, and exposes
 * RLS context helpers (success / failure / missing-context counters + events).
 *
 * Hard guarantees of this layer:
 *  - never logs secrets (passwords, tokens, Authorization, cookies, API keys);
 *  - never logs raw SQL text or query parameters (slow queries carry a SQL HASH);
 *  - metrics labels are low-cardinality only (no tenant/property/user/request ids).
 */

const baseLogger = require('../config/logger');
const { buildObservabilityMetrics } = require('./metrics');
const { buildSlowQueryDetector } = require('./slowQuery');
const { buildSecurityEvents } = require('./securityEvents');

/**
 * Build an observability handle. `logger`/`metrics` are injectable so tests can
 * supply a capturing logger and a fresh metrics engine; production uses the
 * shared singleton from getObservability().
 */
function buildObservability({ logger, metrics } = {}) {
  const log = logger || baseLogger.child({ component: 'observability' });
  // The metrics wrapper owns the single registry. The slow-query detector is
  // built WITHOUT metrics so it only logs; instrumentedPool feeds the registry
  // exactly once (op counter/timing + slow bucket), avoiding double counting.
  const metricsApi = buildObservabilityMetrics({ engine: metrics });
  const slowQuery = buildSlowQueryDetector({ logger: log });
  const security = buildSecurityEvents({ logger: log, metrics: metricsApi.engine });

  const rls = {
    /** Record a successful RLS context bind. scope: 'tenant' | 'property'. */
    contextSet(scope) {
      metricsApi.rls(scope === 'property' ? 'property_switch' : 'tenant_switch');
    },
    /** Record + log a missing required RLS context (also a security event). */
    missingContext(scope) {
      metricsApi.rls('context_failure');
      const evt = scope === 'property' ? 'db.missing_property_context' : 'db.missing_tenant_context';
      return security.emit(evt, { scope });
    },
    /** Record + log an RLS denial / cross-tenant violation. */
    denied(detail = {}) {
      metricsApi.rls('denied');
      return security.emit('db.rls_violation', detail);
    }
  };

  return {
    logger: log,
    metrics: metricsApi,
    slowQuery,
    security,
    rls,
    snapshot: () => metricsApi.snapshot(),
    prometheus: () => metricsApi.prometheus(),
    summary: () => metricsApi.summary(),
    reset: () => metricsApi.reset()
  };
}

let singleton = null;

/** Lazily-built process-wide observability handle. */
function getObservability() {
  if (!singleton) singleton = buildObservability();
  return singleton;
}

module.exports = { buildObservability, getObservability };
