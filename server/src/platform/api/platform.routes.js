'use strict';

/**
 * Platform routes (mounted at /api/platform). Additive; runs after the existing
 * protected chain (so requests are already authenticated). RBAC reuses reserved
 * permissions; observability middleware records metrics/logs per request.
 */

const express = require('express');
const { requirePermission, requirePlatformRole } = require('../../middleware/authorization');
const { buildController } = require('./platform.controller');
const { buildPlatformMiddleware } = require('../middleware/platformMiddleware');
const { getObservability } = require('../../observability');

function build(deps = {}) {
  const router = express.Router();

  // Explicit platform-level RBAC guard for all Phase 57 tenant/invitation routes.
  // Applied PER-ROUTE (not router.use) so the legacy observability routes below
  // keep their existing permission guards without breaking existing users.
  const platformGuard = requirePlatformRole();

  // ---- Phase 57: tenant provisioning (platform_admin / super_admin only) ----
  // These routes are live even when the legacy `deps.platform` observability
  // module is not wired, so they are registered before the early-return guard.
  if (deps.tenantProvisioningService) {
    router.post('/tenants', platformGuard, requirePermission('tenant.provision'), async (req, res, next) => {
      try {
        const ctx = req.ctx || {};
        const result = await deps.tenantProvisioningService.provisionTenant(req.body || {}, ctx);
        if (!result.ok) {
          return res.status(result.error === 'validation_failed' ? 400 : 409)
            .json({ error: result.error, detail: result.detail, requestId: ctx.requestId });
        }
        res.status(201).json({
          ok: true,
          tenantId:    result.tenantId,
          propertyId:  result.propertyId,
          invitation:  result.invitation,
          requestId:   ctx.requestId
        });
      } catch (err) { next(err); }
    });
  }

  if (deps.invitationService) {
    // Create an invitation within a tenant
    router.post('/tenants/:tenantId/invitations', platformGuard, requirePermission('invitation.create.any'), async (req, res, next) => {
      try {
        const ctx = req.ctx || {};
        const { tenantId } = req.params;
        const { email, role_codes, property_ids } = req.body || {};
        const result = await deps.invitationService.createInvitation({
          tenantId,
          email, roleCodes: role_codes, propertyIds: property_ids,
          invitedBy: ctx.actorId,
          actorRoleCodes: ctx.roleCodes || []
        }, ctx);
        if (!result.ok) {
          return res.status(result.error === 'invitation_already_pending' ? 409 : 400)
            .json({ error: result.error, detail: result.detail, requestId: ctx.requestId });
        }
        res.status(201).json({ ok: true, invitationId: result.invitationId, expiresAt: result.expiresAt, requestId: ctx.requestId });
      } catch (err) { next(err); }
    });

    router.patch('/invitations/:id/revoke', platformGuard, requirePermission('invitation.revoke.any'), async (req, res, next) => {
      try {
        const ctx = req.ctx || {};
        const result = await deps.invitationService.revokeInvitation(
          { invitationId: req.params.id, revokedBy: ctx.actorId }, ctx
        );
        if (!result.ok) {
          return res.status(result.error === 'not_found' ? 404 : 400)
            .json({ error: result.error, detail: result.detail, requestId: ctx.requestId });
        }
        res.status(200).json({ ok: true, requestId: ctx.requestId });
      } catch (err) { next(err); }
    });
  }

  if (!deps.platform) return router;     // graceful when legacy platform not wired
  const c = buildController({ platform: deps.platform });

  router.use(buildPlatformMiddleware({ platform: deps.platform }));

  // Phase 33: Prometheus exposition of the process-wide observability registry
  // (HTTP/DB/RLS/business counters + latency). Guarded by the same read
  // permission as the other admin/observability reads; the protected chain has
  // already authenticated the request. Emits only low-cardinality series - no
  // ids, no SQL text, no raw paths.
  router.get('/metrics', requirePermission('bi.dashboard.read'), (_req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(getObservability().prometheus());
  });

  // Phase 34: admin-UI-safe aggregated JSON summary (same guard as /metrics).
  // Aggregates only - no ids, SQL text/params, secrets, tokens, or raw paths.
  router.get('/metrics/summary', requirePermission('bi.dashboard.read'), (req, res) => {
    res.json({ ok: true, data: getObservability().summary(), requestId: (req.ctx || {}).requestId });
  });

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
