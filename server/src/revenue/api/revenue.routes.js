'use strict';

/**
 * Revenue Management routes (mounted at /api/revenue). RBAC via the reserved
 * permissions (migration 0030): revenue.snapshot.read / .write.
 */

const express = require('express');
const { requirePermission } = require('../../middleware/authorization');
const { buildController } = require('./revenue.controller');

function build(deps = {}) {
  const router = express.Router();
  if (!deps.revenue) return router;     // graceful when revenue engine not wired
  const c = buildController({ revenue: deps.revenue });

  router.get('/rate',       requirePermission('revenue.snapshot.read'),  c.getRate);
  router.get('/rate-grid',  requirePermission('revenue.snapshot.read'),  c.rateGrid);
  router.get('/forecast',   requirePermission('revenue.snapshot.read'),  c.forecast);
  router.get('/kpis',       requirePermission('revenue.snapshot.read'),  c.kpis);
  router.get('/dashboard',  requirePermission('revenue.snapshot.read'),  c.dashboard);
  router.post('/rate-plan', requirePermission('revenue.snapshot.write'), c.setRatePlan);
  router.post('/override',  requirePermission('revenue.snapshot.write'), c.override);

  return router;
}

module.exports = { build };
