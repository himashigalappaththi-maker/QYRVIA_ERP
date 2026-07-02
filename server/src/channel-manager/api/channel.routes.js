'use strict';

/**
 * Channel Manager routes (mounted at /api/channel).
 *
 * RBAC reuses the already-seeded reserved permissions (migration 0030):
 *   channel.sync.run    - rate/inventory/booking sync + confirm/cancel
 *   channel.mapping.read - read-only status
 */

const express = require('express');
const env = require('../../config/env');
const { requirePermission } = require('../../middleware/authorization');
const { buildController } = require('./channel.controller');
const { buildControlSnapshot } = require('./controlSnapshot');

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

  // Phase 37 WI-2b - readiness-only "test connection" diagnostic (no network, no secrets).
  router.post('/test-connection',   requirePermission('channel.sync.read'),    c.testConnection);

  // Phase 25 - control-center snapshot (non-secret operational status for the UI).
  router.get( '/control',           requirePermission('channel.mapping.read'), (req, res) => {
    const ctx = req.ctx || {};
    res.json({ ok: true, data: buildControlSnapshot(deps, ctx, env), requestId: ctx.requestId });
  });

  // Phase 24 B8-B4 - inbound webhook ingress. ADDITIVE + GATED: mounted only when
  // CHANNEL_WEBHOOK_ENABLED=true AND the inbound pipeline is wired. Default off =>
  // route absent => zero API change.
  if (env.CHANNEL_WEBHOOK_ENABLED === 'true' && deps.channelInbound && deps.channelInbound.ingress) {
    router.post('/webhook/:channel', requirePermission('channel.sync.run'), async (req, res, next) => {
      try {
        const ctx = req.ctx || {};
        const out = await deps.channelInbound.ingress.handle({
          channel:   req.params.channel,
          body:      req.body || {},
          rawBody:   req.rawBody,
          signature: (req.headers || {})['x-channel-signature'],
          ctx
        });
        return res.status(out.status || (out.ok ? 200 : 400)).json(
          out.ok ? { ok: true, data: out.ingested, requestId: ctx.requestId }
                 : { ok: false, error: out.error, requestId: ctx.requestId }
        );
      } catch (e) { next(e); }
    });
  }

  return router;
}

module.exports = { build };
