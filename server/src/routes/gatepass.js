'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const logger = require('../config/logger');
const { runWithAudit } = require('../audit/pipeline');

/**
 * /api/gatepass — Gate pass CRUD with server-side agent isolation.
 *
 * Agent enforcement guarantees (Phase 46B):
 *   - created_by_user_id is ALWAYS stamped from req.ctx.actorId (JWT sub).
 *     Any client-supplied value in the request body is silently ignored.
 *   - Agents may only issue GUEST or VISITOR type passes.
 *   - Agents must supply a reservation_id (anonymous passes are not allowed).
 *   - Agents may not scan or approve passes.
 *   - GET /api/gatepass filters to the calling agent's own records server-side;
 *     admin/super roles receive the full tenant list.
 *
 * Remaining limitations: OPS security-patrol has no server backend (HTML-only).
 * Gate pass scanning in the OPS module is not backed by this route today.
 */
function build({ gatepasRepo } = {}) {
  const router = express.Router();
  if (!gatepasRepo) return router;

  function isAgent(ctx) {
    return Array.isArray(ctx.roleCodes) && ctx.roleCodes.includes('agent');
  }

  router.get('/', requirePermission('gatepass.read'), async (req, res, next) => {
    try {
      const all  = await gatepasRepo.list(req.ctx);
      const rows = isAgent(req.ctx)
        ? all.filter(p => p.created_by_user_id === req.ctx.actorId)
        : all;
      res.json({ ok: true, requestId: req.ctx.requestId, data: rows });
    } catch (err) { next(err); }
  });

  router.post('/', requirePermission('gatepass.write'), async (req, res, next) => {
    try {
      const body = req.body || {};

      if (isAgent(req.ctx) && !['GUEST', 'VISITOR'].includes(body.type)) {
        logger.warn({ actorId: req.ctx.actorId, type: body.type }, '[gatepass] agent type denied');
        return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'Agents may only issue GUEST or VISITOR passes' });
      }
      if (isAgent(req.ctx) && !body.reservation_id) {
        logger.warn({ actorId: req.ctx.actorId }, '[gatepass] agent missing reservation_id');
        return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'reservation_id is required for agent gate passes' });
      }

      const record = {
        tenant_id:          req.ctx.tenantId,
        property_id:        req.ctx.propertyId || null,
        pass_no:            body.pass_no || ('GP-' + Date.now()),
        type:               body.type,
        name:               body.name,
        movement:           body.movement || 'IN/OUT',
        reservation_id:     body.reservation_id || null,
        created_by_user_id: req.ctx.actorId,   // stamped from verified JWT — not client body
        purpose:            body.purpose || null,
        status:             'ACTIVE',
        valid_from:         body.valid_from || new Date().toISOString(),
      };

      // Route through the established command/audit pipeline (runWithAudit)
      // so the create is recorded in audit_events with actor/tenant/property/
      // request_id/entity — without changing the HTTP request or response shape.
      const outcome = await runWithAudit(
        { name: 'gatepass.create', aggregateType: 'gate_pass' },
        { type: record.type, movement: record.movement, reservation_id: record.reservation_id },
        req.ctx,
        async () => {
          const pass = await gatepasRepo.create(record, req.ctx);
          return { ok: true, result: pass, entityType: 'gate_pass', entityId: pass.id };
        }
      );
      if (!outcome.ok) return next(Object.assign(new Error(outcome.detail || outcome.error || 'gatepass_create_failed'), { code: outcome.error }));
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  router.post('/:id/scan', requirePermission('gatepass.write'), async (req, res, next) => {
    try {
      if (isAgent(req.ctx)) {
        logger.warn({ actorId: req.ctx.actorId, passId: req.params.id }, '[gatepass] agent scan denied');
        return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'Agents may not scan or approve gate passes' });
      }
      const outcome = await runWithAudit(
        { name: 'gatepass.scan', aggregateType: 'gate_pass' },
        { id: req.params.id, direction: (req.body || {}).direction || 'IN' },
        req.ctx,
        async () => {
          const pass = await gatepasRepo.recordScan(req.params.id, req.body || {}, req.ctx);
          return { ok: true, result: pass, entityType: 'gate_pass', entityId: req.params.id };
        }
      );
      if (!outcome.ok) return next(Object.assign(new Error(outcome.detail || outcome.error || 'gatepass_scan_failed'), { code: outcome.error }));
      if (!outcome.result) return res.status(404).json({ ok: false, requestId: req.ctx.requestId, error: 'gate_pass_not_found' });
      res.json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
