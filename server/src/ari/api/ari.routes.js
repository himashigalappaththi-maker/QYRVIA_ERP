'use strict';

/**
 * ARI management routes (Phase 52 D6).
 * Mounted at /api/ari by api.js (D7).
 *
 * All routes require authentication + identityContext (supplied by protectedChain in api.js).
 * RBAC: read endpoints require pms.ari.read; write endpoints require pms.ari.write.
 *
 * If ariService/ariStore are absent, returns an empty router that still processes
 * requests (handlers return graceful ari_not_configured responses).
 */

const express = require('express');
const { requirePermission } = require('../../middleware/authorization');
const { buildAriHandlers } = require('./ari.handlers');

function build({ ariService, ariStore } = {}) {
  const router = express.Router();
  const h = buildAriHandlers({ ariService, ariStore });

  // Room types
  router.get('/room-types',        requirePermission('pms.ari.read'),  h.listRoomTypes);
  router.post('/room-types',       requirePermission('pms.ari.write'), h.upsertRoomType);

  // Rate plans
  router.get('/rate-plans',        requirePermission('pms.ari.read'),  h.listRatePlans);
  router.post('/rate-plans',       requirePermission('pms.ari.write'), h.upsertRatePlan);

  // Inventory grid
  router.get('/inventory',         requirePermission('pms.ari.read'),  h.getInventory);
  router.post('/inventory/cell',   requirePermission('pms.ari.write'), h.upsertInventoryCell);
  router.post('/inventory/adjust-sold', requirePermission('pms.ari.write'), h.adjustSold);

  // Rules
  router.post('/rate-rules',       requirePermission('pms.ari.write'), h.upsertRateRule);
  router.post('/restriction-rules',requirePermission('pms.ari.write'), h.upsertRestrictionRule);

  // Compute + quote
  router.get('/compute',           requirePermission('pms.ari.read'),  h.computeAri);
  router.get('/quote',             requirePermission('pms.ari.read'),  h.quoteStay);

  return router;
}

module.exports = { build };
