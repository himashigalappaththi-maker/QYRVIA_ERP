'use strict';

const express = require('express');
const router  = express.Router();

/**
 * Connector probe / health endpoints.
 *
 * Per /qy-contracts in the frontend, these endpoints must exist with a
 * defined shape so the QYRVIA_CONNECTOR.probe()/healthCheck() client code
 * stops seeing network errors. Phase 1 returns honest not_configured
 * responses because no real backend connector handlers exist yet.
 *
 * Phase 6+ replaces these stubs with real per-connector implementations
 * (e.g. booking_com -> hit Booking.com partner API).
 */

const KNOWN_IDS = new Set([
  'booking_com', 'expedia', 'agoda', 'whatsapp',
  'stripe', 'smtp', 'postgres', 'ai_proxy'
]);

router.get('/:id/probe', (req, res) => {
  const id = req.params.id;
  res.status(200).json({
    id,
    configured: false,
    known:      KNOWN_IDS.has(id),
    missing:    ['BACKEND_NOT_WIRED'],
    note:       'phase-1 stub - real probe arrives when connector module ships',
    requestId:  req.ctx.requestId
  });
});

router.post('/:id/health', (req, res) => {
  const id = req.params.id;
  res.status(200).json({
    id,
    healthy:   false,
    known:     KNOWN_IDS.has(id),
    error:     'not_configured',
    note:      'phase-1 stub - real health check arrives when connector module ships',
    requestId: req.ctx.requestId
  });
});

module.exports = router;
