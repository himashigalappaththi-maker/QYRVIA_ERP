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
  const c = buildController({
    channelManager: deps.channelManager,
    deadLetter: deps.channelPersistence && deps.channelPersistence.deadLetter,
    credentials: deps.channelCredentials,
    mapping: deps.channelMapping,
    channelRegistry: deps.channelRegistry,   // Phase 49
    syncMonitor: (deps.channelOutboundSync && deps.channelOutboundSync.syncMonitor) || null,  // H4: Phase 53
    syncLockStore: (deps.channelPersistence && deps.channelPersistence.syncLock) || null  // Fix 2: reconciliation lock
  });

  router.post('/sync/rates',        requirePermission('channel.sync.run'),     c.syncRates);
  router.post('/sync/inventory',    requirePermission('channel.sync.run'),     c.syncInventory);
  router.post('/bookings/sync',     requirePermission('channel.sync.run'),     c.syncBookings);
  router.post('/bookings/confirm',  requirePermission('channel.sync.run'),     c.confirmBooking);
  router.post('/bookings/cancel',   requirePermission('channel.sync.run'),     c.cancelBooking);
  router.get( '/status',            requirePermission('channel.mapping.read'), c.status);

  // Phase 37 WI-3 - channel operational surfaces (READ envelope, metadata-only).
  router.get( '/sync-health',       requirePermission('channel.sync.read'),    c.syncHealth);
  router.get( '/dlq',               requirePermission('channel.sync.read'),    c.dlqList);
  router.post('/dlq/reprocess',     requirePermission('channel.sync.run'),     c.dlqReprocess);

  // Phase 40 - credential (write-only) + mapping management. Status/list are read
  // (channel.sync.read); save/upsert are actions (channel.sync.run). No secrets returned.
  router.get( '/credentials/status', requirePermission('channel.sync.read'),   c.credentialsStatus);
  router.post('/credentials',        requirePermission('channel.sync.run'),    c.credentialsSave);
  router.get( '/mappings',           requirePermission('channel.sync.read'),   c.mappingsList);
  router.post('/mappings',           requirePermission('channel.sync.run'),    c.mappingsSave);

  // Phase 37 WI-2b - readiness-only "test connection" diagnostic (no network, no secrets).
  router.post('/test-connection',   requirePermission('channel.sync.read'),    c.testConnection);

  // Phase 49 - channel registry CRUD. channel.sync.read = list/get; channel.sync.run = mutations.
  router.get(   '/registry',                     requirePermission('channel.sync.read'), c.registryList);
  router.post(  '/registry',                     requirePermission('channel.sync.run'),  c.registryAdd);
  router.get(   '/registry/:channel',            requirePermission('channel.sync.read'), c.registryGet);
  router.patch( '/registry/:channel/status',     requirePermission('channel.sync.run'),  c.registrySetStatus);
  router.patch( '/registry/:channel/toggle',     requirePermission('channel.sync.run'),  c.registryToggle);
  router.post(  '/registry/:channel/sync-error', requirePermission('channel.sync.run'),  c.registryRecordError);
  router.post(  '/registry/:channel/sync-ok',    requirePermission('channel.sync.run'),  c.registryRecordSync);

  // Phase 50 - reconciliation: pure drift report, no OTA call (read permission only).
  router.post('/reconciliation', requirePermission('channel.sync.read'), c.reconciliation);

  // Phase 53 Fix 4 - emergency kill switch (distinct from toggle; records kill_switch_at/by/reason).
  router.patch('/registry/:channel/kill', requirePermission('channel.sync.run'), c.killChannel);

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
