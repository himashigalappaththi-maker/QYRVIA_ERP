'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const logger = require('../config/logger');

/**
 * /api/pos — POS order endpoints with server-side agent isolation.
 *
 * Agent enforcement guarantees (Phase 46B):
 *   - created_by_user_id is ALWAYS stamped from req.ctx.actorId (JWT sub).
 *   - Agents may only create Room Service orders.
 *   - GET /api/pos/orders filters to the calling agent's own records server-side.
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

      const record = {
        tenant_id:          req.ctx.tenantId,
        property_id:        req.ctx.propertyId || null,
        type:               body.type || 'Room Service',
        table_ref:          body.table_ref || body.table || null,
        items:              body.items || [],
        notes:              body.notes || null,
        status:             'Pending',
        created_by_user_id: req.ctx.actorId,   // stamped from verified JWT — not client body
      };
      const order = await posOrderRepo.create(record, req.ctx);
      res.status(201).json({ ok: true, requestId: req.ctx.requestId, data: order });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
