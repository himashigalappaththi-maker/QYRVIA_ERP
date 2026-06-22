'use strict';

/**
 * Channel Manager routes (mounted at /api/channel).
 *
 * RBAC reuses the already-seeded reserved permissions (migration 0030):
 *   channel.sync.run    - rate/inventory/booking sync + confirm/cancel
 *   channel.mapping.read - read-only status
 */

const express = require('express');
const { requirePermission } = require('../../middleware/authorization');
const { buildController } = require('./channel.controller');

function build(deps = {}) {
  const router = express.Router();
  if (!deps.channelManager) return router;   // graceful: no CM wired
  const c = buildController({ channelManager: deps.channelManager });

  router.post('/sync/rates',        requirePermission('channel.sync.run'),     c.syncRates);
  router.post('/sync/inventory',    requirePermission('channel.sync.run'),     c.syncInventory);
  router.post('/bookings/sync',     requirePermission('channel.sync.run'),     c.syncBookings);
  router.post('/bookings/confirm',  requirePermission('channel.sync.run'),     c.confirmBooking);
  router.post('/bookings/cancel',   requirePermission('channel.sync.run'),     c.cancelBooking);
  router.get( '/status',            requirePermission('channel.mapping.read'), c.status);

  return router;
}

module.exports = { build };
