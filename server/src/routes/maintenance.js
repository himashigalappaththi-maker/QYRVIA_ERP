'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const { runWithAudit } = require('../audit/pipeline');

/**
 * /api/maintenance — Maintenance work order CRUD.
 *
 * RBAC:
 *   maintenance.read     — list and read
 *   maintenance.create   — create new work order
 *   maintenance.assign   — assign to a technician
 *   maintenance.update   — update status / details
 *   maintenance.complete — mark work order completed
 *
 * Property context resolved server-side. tenant_id, property_id, and
 * reported_by_user_id are NEVER accepted from request bodies.
 */
function build({ maintenanceRepo } = {}) {
  const router = express.Router();
  if (!maintenanceRepo) return router;

  function handlePropertyError(err, req, res) {
    if (err && err.code === 'MAINTENANCE_PROPERTY_REQUIRED') {
      return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'maintenance_property_required' }), true;
    }
    if (err && err.code === 'PROPERTY_ACCESS_DENIED') {
      return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'property_access_denied' }), true;
    }
    return false;
  }

  // GET /api/maintenance
  router.get('/', requirePermission('maintenance.read'), async (req, res, next) => {
    try {
      const rows = await maintenanceRepo.list(req.ctx, {
        status: req.query.status || undefined,
        limit:  req.query.limit  || undefined,
      });
      res.json({ ok: true, requestId: req.ctx.requestId, data: rows });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
  });

  // GET /api/maintenance/:id
  router.get('/:id', requirePermission('maintenance.read'), async (req, res, next) => {
    try {
      const row = await maintenanceRepo.findById(req.ctx, req.params.id);
      if (!row) return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'work_order_not_found' });
      res.json({ ok: true, requestId: req.ctx.requestId, data: row });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
  });

  // POST /api/maintenance
  router.post('/', requirePermission('maintenance.create'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.title || !String(body.title).trim()) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'title is required' });
      }
      const rec = {
        asset_or_location:   body.asset_or_location || body.room || null,
        category:            body.category   || 'General',
        priority:            body.priority   || 'medium',
        title:               String(body.title).trim(),
        description:         body.description || null,
        due_at:              body.due_at     || null,
        reported_by_user_id: req.ctx.actorId,   // stamped from JWT — not client body
      };
      const outcome = await runWithAudit(
        { name: 'maintenance.create', aggregateType: 'maintenance_work_order' },
        { category: rec.category, priority: rec.priority },
        req.ctx,
        async () => {
          try {
            const row = await maintenanceRepo.create(rec, req.ctx);
            return { ok: true, result: row, entityType: 'maintenance_work_order', entityId: row.id };
          } catch (err) {
            if (err && err.code === 'MAINTENANCE_PROPERTY_REQUIRED') return { ok: false, error: 'maintenance_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')        return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'maintenance_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'maintenance_create_failed'), { code: outcome.error }));
      }
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  // PATCH /api/maintenance/:id/assign
  router.patch('/:id/assign', requirePermission('maintenance.assign'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.assigned_to_user_id) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'assigned_to_user_id is required' });
      }
      const outcome = await runWithAudit(
        { name: 'maintenance.assign', aggregateType: 'maintenance_work_order' },
        { id: req.params.id, assignedTo: body.assigned_to_user_id },
        req.ctx,
        async () => {
          try {
            const row = await maintenanceRepo.assign(req.params.id, req.ctx, {
              assignedToUserId: body.assigned_to_user_id
            });
            if (!row) return { ok: false, error: 'work_order_not_found' };
            return { ok: true, result: row, entityType: 'maintenance_work_order', entityId: req.params.id };
          } catch (err) {
            if (err && err.code === 'MAINTENANCE_PROPERTY_REQUIRED') return { ok: false, error: 'maintenance_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')        return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'work_order_not_found')
          return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'work_order_not_found' });
        if (outcome.error === 'maintenance_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'maintenance_assign_failed'), { code: outcome.error }));
      }
      res.json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  // PATCH /api/maintenance/:id/status
  router.patch('/:id/status', requirePermission('maintenance.update'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.status) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'status is required' });
      }
      const outcome = await runWithAudit(
        { name: 'maintenance.update', aggregateType: 'maintenance_work_order' },
        { id: req.params.id, status: body.status },
        req.ctx,
        async () => {
          try {
            const row = await maintenanceRepo.updateStatus(req.params.id, req.ctx, {
              status:          body.status,
              resolutionNotes: body.resolution_notes || null,
            });
            if (!row) return { ok: false, error: 'work_order_not_found' };
            return { ok: true, result: row, entityType: 'maintenance_work_order', entityId: req.params.id };
          } catch (err) {
            if (err && err.code === 'INVALID_STATUS')                return { ok: false, error: 'invalid_status' };
            if (err && err.code === 'MAINTENANCE_PROPERTY_REQUIRED') return { ok: false, error: 'maintenance_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')        return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'work_order_not_found')
          return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'work_order_not_found' });
        if (outcome.error === 'invalid_status')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'invalid_status' });
        if (outcome.error === 'maintenance_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'maintenance_update_failed'), { code: outcome.error }));
      }
      res.json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  // PATCH /api/maintenance/:id/complete
  router.patch('/:id/complete', requirePermission('maintenance.complete'), async (req, res, next) => {
    try {
      const body = req.body || {};
      const outcome = await runWithAudit(
        { name: 'maintenance.complete', aggregateType: 'maintenance_work_order' },
        { id: req.params.id },
        req.ctx,
        async () => {
          try {
            const row = await maintenanceRepo.complete(req.params.id, req.ctx, {
              resolutionNotes: body.resolution_notes || null,
            });
            if (!row) return { ok: false, error: 'work_order_not_found' };
            return { ok: true, result: row, entityType: 'maintenance_work_order', entityId: req.params.id };
          } catch (err) {
            if (err && err.code === 'MAINTENANCE_PROPERTY_REQUIRED') return { ok: false, error: 'maintenance_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')        return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'work_order_not_found')
          return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'work_order_not_found' });
        if (outcome.error === 'maintenance_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'maintenance_complete_failed'), { code: outcome.error }));
      }
      res.json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
