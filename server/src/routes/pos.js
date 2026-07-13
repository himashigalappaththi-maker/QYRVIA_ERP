'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const logger = require('../config/logger');
const { runWithAudit } = require('../audit/pipeline');

/**
 * /api/pos — POS order endpoints with server-side agent isolation.
 *
 * Agent enforcement guarantees (Phase 46B):
 *   - created_by_user_id is ALWAYS stamped from req.ctx.actorId (JWT sub).
 *   - Agents may only create Room Service orders.
 *   - GET /api/pos/orders filters to the calling agent's own records server-side.
 *
 * Property resolution (M1A correction round):
 *   - The repo resolves the order's property from the AUTHENTICATED user's
 *     real authorized-property set (identityRepo.listAccessibleProperties /
 *     canAccessProperty) — never from the request body, and never from an
 *     unrestricted tenant-wide query. See src/db/repos.js#_resolveAuthorizedPropertyId.
 *   - POS_PROPERTY_REQUIRED (multiple authorized properties, no active
 *     context) surfaces as 400.
 *   - PROPERTY_ACCESS_DENIED (zero authorized properties, or the active
 *     property context failed re-verification) surfaces as 403.
 */
function build({ posOrderRepo } = {}) {
  const router = express.Router();
  if (!posOrderRepo) return router;

  function isAgent(ctx) {
    return Array.isArray(ctx.roleCodes) && ctx.roleCodes.includes('agent');
  }

  router.get('/orders', requirePermission('pos.order.read'), async (req, res, next) => {
    try {
      const all  = await posOrderRepo.list(req.ctx);
      const rows = isAgent(req.ctx)
        ? all.filter(o => o.created_by_user_id === req.ctx.actorId)
        : all;
      res.json({ ok: true, requestId: req.ctx.requestId, data: rows });
    } catch (err) { next(err); }
  });

  router.post('/orders', requirePermission('pos.order.write'), async (req, res, next) => {
    try {
      const body = req.body || {};

      if (isAgent(req.ctx) && body.type !== 'Room Service') {
        logger.warn({ actorId: req.ctx.actorId, type: body.type }, '[pos] agent order type denied');
        return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'Agents may only create Room Service orders' });
      }

      // tenant_id, property_id, and created_by_user_id are NEVER taken from
      // the client body — tenant_id/actor are stamped from the verified JWT
      // (req.ctx), and property_id is resolved server-side by the repo from
      // the authenticated user's authorized-property set (see repos.js).
      // Any tenant_id/property_id/created_by_user_id/role fields present in
      // `body` are silently ignored below.
      const record = {
        tenant_id:  req.ctx.tenantId,          // stamped from verified JWT — not client body
        type:       body.type || 'Room Service',
        table_ref:  body.table_ref || body.table || null,
        items:      body.items || [],
        notes:      body.notes || null,
        status:     'Pending',
        created_by_user_id: req.ctx.actorId,   // stamped from verified JWT — not client body
      };

      const outcome = await runWithAudit(
        { name: 'pos_order.create', aggregateType: 'pos_order' },
        { type: record.type, table_ref: record.table_ref, item_count: (record.items || []).length },
        req.ctx,
        async () => {
          try {
            const order = await posOrderRepo.create(record, req.ctx);
            return { ok: true, result: order, entityType: 'pos_order', entityId: order.id };
          } catch (err) {
            if (err && err.code === 'POS_PROPERTY_REQUIRED') return { ok: false, error: 'property_context_required' };
            if (err && err.code === 'PROPERTY_ACCESS_DENIED') return { ok: false, error: 'property_access_denied' };
            throw err;
          }
        }
      );
      if (!outcome.ok) {
        if (outcome.error === 'property_context_required') {
          // Multiple authorized properties, no active X-Property-Id context —
          // genuine 400 (ambiguous), not a 500.
          return res.status(400).json({ ok: false, requestId: req.ctx.requestId, error: 'property_context_required' });
        }
        if (outcome.error === 'property_access_denied') {
          // Zero authorized properties, or the active property context is not
          // one this user is authorized for — genuine 403.
          return res.status(403).json({ ok: false, requestId: req.ctx.requestId, error: 'property_access_denied' });
        }
        return next(Object.assign(new Error(outcome.detail || outcome.error || 'pos_order_create_failed'), { code: outcome.error }));
      }
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: outcome.result });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
