'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const logger = require('../config/logger');
const { runWithAudit } = require('../audit/pipeline');

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
 *
 * Property scoping (M1A correction round): patrol points/logs are physical-
 * property operational records — property_id is NOT NULL on both tables
 * (migration 0078). Every route below resolves its property from the
 * AUTHENTICATED user's authorized-property set via the repo (see
 * src/db/repos.js#_resolveAuthorizedPropertyId) — never from client input,
 * never from an unrestricted tenant-wide query:
 *   - PATROL_PROPERTY_REQUIRED (multiple authorized properties, no active
 *     context) surfaces as 400.
 *   - PROPERTY_ACCESS_DENIED (zero authorized properties, or the active
 *     property context failed re-verification) surfaces as 403.
 */
function build({ patrolRepo } = {}) {
  const router = express.Router();
  if (!patrolRepo) return router;

  function isAgent(ctx) {
    return Array.isArray(ctx.roleCodes) && ctx.roleCodes.includes('agent');
  }

  // Shared translation for the property-resolution errors thrown by every
  // patrolRepo method. Returns true if the error was handled (response sent).
  function handlePropertyError(err, req, res) {
    if (err && err.code === 'PATROL_PROPERTY_REQUIRED') {
      res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'patrol_property_required' });
      return true;
    }
    if (err && err.code === 'PROPERTY_ACCESS_DENIED') {
      res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'property_access_denied' });
      return true;
    }
    return false;
  }

  // ── Patrol Points ───────────────────────────────────────────────────────

  router.get('/points', requirePermission('patrol.point.read'), async (req, res, next) => {
    try {
      const points = await patrolRepo.listPoints(req.ctx);
      res.json({ ok: true, requestId: req.ctx.requestId, data: points });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
  });

  router.post('/points', requirePermission('patrol.point.write'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.name) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'name is required' });
      }
      // tenant_id/property_id are NEVER taken from the client body — tenant_id
      // is stamped from the verified JWT (req.ctx) and property_id is resolved
      // server-side by the repo from the user's authorized-property set.
      const record = {
        tenant_id:   req.ctx.tenantId,         // stamped from verified JWT — not client body
        name:        body.name,
        zone:        body.zone || 'Exterior',
        lat:         body.lat != null ? parseFloat(body.lat) : null,
        lng:         body.lng != null ? parseFloat(body.lng) : null,
        active:      true,
        created_by:  req.ctx.actorId,
      };
      const outcome = await runWithAudit(
        { name: 'patrol_point.create', aggregateType: 'patrol_point' },
        { name: record.name, zone: record.zone },
        req.ctx,
        async () => {
          try {
            const point = await patrolRepo.createPoint(record, req.ctx);
            return { ok: true, result: point, entityType: 'patrol_point', entityId: point.id };
          } catch (err) {
            if (err && err.code === 'PATROL_PROPERTY_REQUIRED') return { ok: false, error: 'patrol_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED') return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'patrol_property_required') {
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'patrol_property_required' });
        }
        if (outcome.error === 'property_access_denied') {
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'property_access_denied' });
        }
        return next(Object.assign(new Error(outcome.detail || outcome.error || 'patrol_point_create_failed'), { code: outcome.error }));
      }
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  router.patch('/points/:id/toggle', requirePermission('patrol.point.write'), async (req, res, next) => {
    try {
      const outcome = await runWithAudit(
        { name: 'patrol_point.toggle', aggregateType: 'patrol_point' },
        { id: req.params.id },
        req.ctx,
        async () => {
          try {
            const point = await patrolRepo.togglePoint(req.params.id, req.ctx);
            return { ok: true, result: point, entityType: 'patrol_point', entityId: req.params.id };
          } catch (err) {
            if (err && err.code === 'PATROL_PROPERTY_REQUIRED') return { ok: false, error: 'patrol_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED') return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'patrol_property_required') {
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'patrol_property_required' });
        }
        if (outcome.error === 'property_access_denied') {
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'property_access_denied' });
        }
        return next(Object.assign(new Error(outcome.detail || outcome.error || 'patrol_point_toggle_failed'), { code: outcome.error }));
      }
      if (!outcome.result) return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'patrol_point_not_found' });
      res.json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  // ── Patrol Logs (check-ins) ─────────────────────────────────────────────

  router.get('/logs', requirePermission('patrol.log.read'), async (req, res, next) => {
    try {
      const logs = await patrolRepo.listLogs(req.ctx);
      res.json({ ok: true, requestId: req.ctx.requestId, data: logs });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
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
      // tenant_id/property_id/officer_id are NEVER taken from the client body —
      // officer_id is stamped from the verified JWT and property_id is resolved
      // server-side by the repo from the user's authorized-property set.
      const record = {
        tenant_id:   req.ctx.tenantId,         // stamped from verified JWT — not client body
        point_id:    body.point_id,
        officer_id:  req.ctx.actorId,
        gps_lat:     gps.lat != null ? parseFloat(gps.lat) : null,
        gps_lng:     gps.lng != null ? parseFloat(gps.lng) : null,
        gps_acc:     gps.acc != null ? String(gps.acc)     : null,
        checked_at:  new Date().toISOString(),
      };
      const outcome = await runWithAudit(
        { name: 'patrol_log.create', aggregateType: 'patrol_log' },
        { point_id: record.point_id },
        req.ctx,
        async () => {
          try {
            const log = await patrolRepo.createLog(record, req.ctx);
            return { ok: true, result: log, entityType: 'patrol_log', entityId: log.id };
          } catch (err) {
            if (err && err.code === 'PATROL_POINT_NOT_FOUND') return { ok: false, error: 'patrol_point_not_found' };
            if (err && err.code === 'PATROL_PROPERTY_REQUIRED') return { ok: false, error: 'patrol_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED') return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'patrol_point_not_found') {
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'patrol_point_not_found' });
        }
        if (outcome.error === 'patrol_property_required') {
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'patrol_property_required' });
        }
        if (outcome.error === 'property_access_denied') {
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'property_access_denied' });
        }
        return next(Object.assign(new Error(outcome.detail || outcome.error || 'patrol_log_create_failed'), { code: outcome.error }));
      }
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
