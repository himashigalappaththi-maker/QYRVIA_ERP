'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const logger = require('../config/logger');

/**
 * /api/patrol — Security patrol points and check-in logs.
 *
 * Phase 48 completes the OPS module backend.  The frontend security-patrol
 * page previously had no server backend (noted in gatepass.js:19).
 *
 * RBAC:
 *   patrol.point.read  — security, supervisor, manager, admin (not agents)
 *   patrol.point.write — manager, admin only (create + toggle)
 *   patrol.log.read    — security, supervisor, manager, admin
 *   patrol.log.write   — security, supervisor, manager, admin (NOT agents;
 *                        Phase 46A blocks agents in the UI; this enforces server-side)
 *
 * Agent isolation: agents have neither patrol.point.* nor patrol.log.* permissions
 * in the standard role set, so they receive 403 from requirePermission before any
 * route handler runs.  An explicit isAgent check is added to log.write as a
 * defence-in-depth measure identical to the gatepass pattern.
 */
function build({ patrolRepo } = {}) {
  const router = express.Router();
  if (!patrolRepo) return router;

  function isAgent(ctx) {
    return Array.isArray(ctx.roleCodes) && ctx.roleCodes.includes('agent');
  }

  // ── Patrol Points ───────────────────────────────────────────────────────

  router.get('/points', requirePermission('patrol.point.read'), async (req, res, next) => {
    try {
      const points = await patrolRepo.listPoints(req.ctx);
      res.json({ ok: true, requestId: req.ctx.requestId, data: points });
    } catch (err) { next(err); }
  });

  router.post('/points', requirePermission('patrol.point.write'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.name) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'name is required' });
      }
      const record = {
        tenant_id:   req.ctx.tenantId,
        property_id: req.ctx.propertyId || null,
        name:        body.name,
        zone:        body.zone || 'Exterior',
        lat:         body.lat != null ? parseFloat(body.lat) : null,
        lng:         body.lng != null ? parseFloat(body.lng) : null,
        active:      true,
        created_by:  req.ctx.actorId,
      };
      const point = await patrolRepo.createPoint(record, req.ctx);
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: point });
    } catch (err) { next(err); }
  });

  router.patch('/points/:id/toggle', requirePermission('patrol.point.write'), async (req, res, next) => {
    try {
      const point = await patrolRepo.togglePoint(req.params.id, req.ctx);
      if (!point) return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'patrol_point_not_found' });
      res.json({ ok: true, requestId: req.ctx.requestId, data: point });
    } catch (err) { next(err); }
  });

  // ── Patrol Logs (check-ins) ─────────────────────────────────────────────

  router.get('/logs', requirePermission('patrol.log.read'), async (req, res, next) => {
    try {
      const logs = await patrolRepo.listLogs(req.ctx);
      res.json({ ok: true, requestId: req.ctx.requestId, data: logs });
    } catch (err) { next(err); }
  });

  router.post('/logs', requirePermission('patrol.log.write'), async (req, res, next) => {
    try {
      if (isAgent(req.ctx)) {
        logger.warn({ actorId: req.ctx.actorId }, '[patrol] agent check-in denied');
        return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'Agents may not record patrol check-ins' });
      }
      const body = req.body || {};
      if (!body.point_id) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'point_id is required' });
      }
      const gps = body.gps || {};
      const record = {
        tenant_id:   req.ctx.tenantId,
        property_id: req.ctx.propertyId || null,
        point_id:    body.point_id,
        officer_id:  req.ctx.actorId,
        gps_lat:     gps.lat != null ? parseFloat(gps.lat) : null,
        gps_lng:     gps.lng != null ? parseFloat(gps.lng) : null,
        gps_acc:     gps.acc != null ? String(gps.acc)     : null,
        checked_at:  new Date().toISOString(),
      };
      const log = await patrolRepo.createLog(record, req.ctx);
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: log });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
