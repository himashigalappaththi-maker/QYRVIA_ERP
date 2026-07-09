'use strict';

/**
 * Booking Engine routes (Phase 26) - mounted at /api/booking. The OFFICIAL
 * reservation entry point: create / update / cancel all go through the Booking
 * Engine orchestration (-> commandBus -> PMS). RBAC reuses pms.reservation.write.
 *
 * Phase 52 D5: GET /quote — price-check (read-only, pms.reservation.read).
 * If ariService is absent from deps, the route still mounts; the handler returns
 * { ok: true, data: { bookable: false, reason: 'ari_not_configured' } } gracefully.
 */

const express = require('express');
const { requirePermission } = require('../../middleware/authorization');
const { buildBookingHandlers, buildQuoteHandler } = require('./bookingHandlers');

function build(deps = {}) {
  const router = express.Router();

  // Quote route: always mounted (graceful when ariService absent)
  const quoteHandler = buildQuoteHandler({ ariService: deps.ariService || null });
  router.get('/quote', requirePermission('pms.reservation.read'), quoteHandler);

  if (!deps.bookingEngine || !deps.bookingEngine.service) return router; // graceful: engine not wired
  const h = buildBookingHandlers({ bookingEngine: deps.bookingEngine });

  router.post('/create',      requirePermission('pms.reservation.write'), h.create);
  router.post('/update/:id',  requirePermission('pms.reservation.write'), h.update);
  router.post('/cancel/:id',  requirePermission('pms.reservation.write'), h.cancel);

  return router;
}

module.exports = { build };
