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

function build(deps = {}) {
  const router = express.Router();
  if (!deps.platform) return router;     // graceful when platform not wired
  const c = buildController({ platform: deps.platform });

  router.use(buildPlatformMiddleware({ platform: deps.platform }));

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
