'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const { runWithAudit } = require('../audit/pipeline');

/**
 * /api/incidents — Incident reporting CRUD.
 *
 * RBAC:
 *   incident.read    — view list and detail
 *   incident.create  — submit new incident
 *   incident.assign  — assign to a staff member
 *   incident.update  — update details / action taken
 *   incident.resolve — resolve / close an incident
 *
 * Property context: resolved server-side via incidentRepo._resolveAuthorizedPropertyId.
 * tenant_id, property_id, and reported_by_user_id are NEVER taken from the request body.
 */
function build({ incidentRepo } = {}) {
  const router = express.Router();
  if (!incidentRepo) return router;

  function handlePropertyError(err, req, res) {
    if (err && err.code === 'INCIDENT_PROPERTY_REQUIRED') {
      return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'incident_property_required' }), true;
    }
    if (err && err.code === 'PROPERTY_ACCESS_DENIED') {
      return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'property_access_denied' }), true;
    }
    return false;
  }

  // GET /api/incidents
  router.get('/', requirePermission('incident.read'), async (req, res, next) => {
    try {
      const rows = await incidentRepo.list(req.ctx, {
        status: req.query.status || undefined,
        limit:  req.query.limit  || undefined,
      });
      res.json({ ok: true, requestId: req.ctx.requestId, data: rows });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
  });

  // GET /api/incidents/:id
  router.get('/:id', requirePermission('incident.read'), async (req, res, next) => {
    try {
      const row = await incidentRepo.findById(req.ctx, req.params.id);
      if (!row) return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'incident_not_found' });
      res.json({ ok: true, requestId: req.ctx.requestId, data: row });
    } catch (err) {
      if (handlePropertyError(err, req, res)) return;
      next(err);
    }
  });

  // POST /api/incidents
  router.post('/', requirePermission('incident.create'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.title || !String(body.title).trim()) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'title is required' });
      }
      const rec = {
        category:            body.category    || 'Other',
        severity:            body.severity    || 'medium',
        title:               String(body.title).trim(),
        description:         body.description || null,
        location_text:       body.location_text || null,
        occurred_at:         body.occurred_at || new Date().toISOString(),
        reported_by_user_id: req.ctx.actorId,    // stamped from JWT — not client body
      };
      const outcome = await runWithAudit(
        { name: 'incident.create', aggregateType: 'incident_report' },
        { category: rec.category, severity: rec.severity },
        req.ctx,
        async () => {
          try {
            const row = await incidentRepo.create(rec, req.ctx);
            return { ok: true, result: row, entityType: 'incident_report', entityId: row.id };
          } catch (err) {
            if (err && err.code === 'INCIDENT_PROPERTY_REQUIRED') return { ok: false, error: 'incident_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')     return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'incident_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'incident_create_failed'), { code: outcome.error }));
      }
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  // PATCH /api/incidents/:id/assign
  router.patch('/:id/assign', requirePermission('incident.assign'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.assigned_to_user_id) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'assigned_to_user_id is required' });
      }
      const outcome = await runWithAudit(
        { name: 'incident.assign', aggregateType: 'incident_report' },
        { id: req.params.id, assignedTo: body.assigned_to_user_id },
        req.ctx,
        async () => {
          try {
            const row = await incidentRepo.updateStatus(req.params.id, req.ctx, {
              status: 'assigned', assignedToUserId: body.assigned_to_user_id
            });
            if (!row) return { ok: false, error: 'incident_not_found' };
            return { ok: true, result: row, entityType: 'incident_report', entityId: req.params.id };
          } catch (err) {
            if (err && err.code === 'INCIDENT_PROPERTY_REQUIRED') return { ok: false, error: 'incident_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')     return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'incident_not_found')
          return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'incident_not_found' });
        if (outcome.error === 'incident_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'incident_assign_failed'), { code: outcome.error }));
      }
      res.json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  // PATCH /api/incidents/:id/status
  router.patch('/:id/status', requirePermission('incident.update'), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.status) {
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'status is required' });
      }
      const outcome = await runWithAudit(
        { name: 'incident.update', aggregateType: 'incident_report' },
        { id: req.params.id, status: body.status },
        req.ctx,
        async () => {
          try {
            const row = await incidentRepo.updateStatus(req.params.id, req.ctx, {
              status:       body.status,
              actionTaken:  body.action_taken  || null,
            });
            if (!row) return { ok: false, error: 'incident_not_found' };
            return { ok: true, result: row, entityType: 'incident_report', entityId: req.params.id };
          } catch (err) {
            if (err && err.code === 'INVALID_STATUS')             return { ok: false, error: 'invalid_status' };
            if (err && err.code === 'INCIDENT_PROPERTY_REQUIRED') return { ok: false, error: 'incident_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')     return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'incident_not_found')
          return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'incident_not_found' });
        if (outcome.error === 'invalid_status')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'invalid_status' });
        if (outcome.error === 'incident_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'incident_update_failed'), { code: outcome.error }));
      }
      res.json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  // PATCH /api/incidents/:id/resolve
  router.patch('/:id/resolve', requirePermission('incident.resolve'), async (req, res, next) => {
    try {
      const body = req.body || {};
      const outcome = await runWithAudit(
        { name: 'incident.resolve', aggregateType: 'incident_report' },
        { id: req.params.id },
        req.ctx,
        async () => {
          try {
            const row = await incidentRepo.updateStatus(req.params.id, req.ctx, {
              status:       'resolved',
              actionTaken:  body.action_taken || null,
              resolvedAt:   new Date().toISOString(),
            });
            if (!row) return { ok: false, error: 'incident_not_found' };
            return { ok: true, result: row, entityType: 'incident_report', entityId: req.params.id };
          } catch (err) {
            if (err && err.code === 'INCIDENT_PROPERTY_REQUIRED') return { ok: false, error: 'incident_property_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED')     return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'incident_not_found')
          return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'incident_not_found' });
        if (outcome.error === 'incident_property_required')
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        if (outcome.error === 'property_access_denied')
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: outcome.error });
        return next(Object.assign(new Error(outcome.error || 'incident_resolve_failed'), { code: outcome.error }));
      }
      res.json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
