'use strict';

/**
 * Platform routes (mounted at /api/platform). Additive; runs after the existing
 * protected chain (so requests are already authenticated). RBAC reuses reserved
 * permissions; observability middleware records metrics/logs per request.
 */

const express = require('express');
const { requirePermission } = require('../../middleware/authorization');
const { buildController } = require('./platform.controller');
const { buildPlatformMiddleware } = require('../middleware/platformMiddleware');
const { getObservability } = require('../../observability');

function build(deps = {}) {
  const router = express.Router();
  if (!deps.platform) return router;     // graceful when platform not wired
  const c = buildController({ platform: deps.platform });

  router.use(buildPlatformMiddleware({ platform: deps.platform }));

  // Phase 33: Prometheus exposition of the process-wide observability registry
  // (HTTP/DB/RLS/business counters + latency). Guarded by the same read
  // permission as the other admin/observability reads; the protected chain has
  // already authenticated the request. Emits only low-cardinality series - no
  // ids, no SQL text, no raw paths.
  router.get('/metrics', requirePermission('bi.dashboard.read'), (_req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(getObservability().prometheus());
  });

  // Phase 34: admin-UI-safe aggregated JSON summary (same guard as /metrics).
  // Aggregates only - no ids, SQL text/params, secrets, tokens, or raw paths.
  router.get('/metrics/summary', requirePermission('bi.dashboard.read'), (req, res) => {
    res.json({ ok: true, data: getObservability().summary(), requestId: (req.ctx || {}).requestId });
  });

  // Admin / observability (read)
  router.get('/admin/metrics', requirePermission('bi.dashboard.read'), c.metrics);
  router.get('/admin/logs',    requirePermission('bi.dashboard.read'), c.logs);
  router.get('/admin/audit',   requirePermission('bi.dashboard.read'), c.audit);

  // Integration hub
  router.get('/integrations/status',  requirePermission('bi.dashboard.read'),   c.integrationsStatus);
  router.post('/integrations/webhook', requirePermission('channel.sync.run'),   c.webhook);
  router.post('/integrations/sync',    requirePermission('channel.sync.run'),   c.sync);

  // Enterprise control (read)
  router.get('/enterprise/properties', requirePermission('bi.dashboard.read'), c.properties);
  router.get('/enterprise/analytics',  requirePermission('bi.dashboard.read'), c.analytics);
  router.get('/enterprise/config',     requirePermission('bi.dashboard.read'), c.config);

  return router;
}

module.exports = { build };
