'use strict';

/**
 * Booking Engine routes (Phase 26) - mounted at /api/booking. The OFFICIAL
 * reservation entry point: create / update / cancel all go through the Booking
 * Engine orchestration (-> commandBus -> PMS). RBAC reuses pms.reservation.write.
 *
 * Phase 52 D5: GET /quote — price-check (read-only, pms.reservation.read).
 * If ariService is absent from deps, the route still mounts; the handler returns
 * { ok: true, data: { bookable: false, reason: 'ari_not_configured' } } gracefully.
 *
 * Phase 54 D7b: rate limiter on POST /create (20 req/min/IP, skip in test).
 * Phase 54 D8b: POST /payment/initiate and POST /payment/confirm/:id.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requirePermission } = require('../../middleware/authorization');
const { buildBookingHandlers, buildQuoteHandler } = require('./bookingHandlers');

// Phase 54 D7b: rate limiter for booking creation (20 req/min/IP).
// Disabled in NODE_ENV=test to avoid cross-test interference.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { ok: false, error: 'rate_limit_exceeded' },
});

function build(deps = {}) {
  const router = express.Router();

  // Quote route: always mounted (graceful when ariService absent)
  const quoteHandler = buildQuoteHandler({ ariService: deps.ariService || null });
  router.get('/quote', requirePermission('pms.reservation.read'), quoteHandler);

  if (!deps.bookingEngine || !deps.bookingEngine.service) return router; // graceful: engine not wired
  const h = buildBookingHandlers({ bookingEngine: deps.bookingEngine });

  router.post('/create',      createLimiter, requirePermission('pms.reservation.write'), h.create);
  router.post('/update/:id',  requirePermission('pms.reservation.write'), h.update);
  router.post('/cancel/:id',  requirePermission('pms.reservation.write'), h.cancel);

  // Phase 54 D8b: two-phase payment routes
  router.post('/payment/initiate',     requirePermission('pms.reservation.write'), h.initiatePayment);
  router.post('/payment/confirm/:id',  requirePermission('pms.reservation.write'), h.confirmPayment);

  return router;
}

module.exports = { build };
