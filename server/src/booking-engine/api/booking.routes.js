'use strict';

/**
 * Booking Engine routes (Phase 26) - mounted at /api/booking. The OFFICIAL
 * reservation entry point: create / update / cancel all go through the Booking
 * Engine orchestration (-> commandBus -> PMS). RBAC reuses pms.reservation.write.
 */

const express = require('express');
const { requirePermission } = require('../../middleware/authorization');
const { buildBookingHandlers } = require('./bookingHandlers');

function build(deps = {}) {
  const router = express.Router();
  if (!deps.bookingEngine || !deps.bookingEngine.service) return router; // graceful: engine not wired
  const h = buildBookingHandlers({ bookingEngine: deps.bookingEngine });

  router.post('/create',      requirePermission('pms.reservation.write'), h.create);
  router.post('/update/:id',  requirePermission('pms.reservation.write'), h.update);
  router.post('/cancel/:id',  requirePermission('pms.reservation.write'), h.cancel);

  return router;
}

module.exports = { build };
