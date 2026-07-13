'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');
const { withTenant } = require('../db/client');

function build({ notificationService }) {
  const router = express.Router();
  if (!notificationService) return router;

  router.post('/', requirePermission('notifications.send'), async (req, res, next) => {
    try {
      const r = await withTenant(req.ctx.tenantId, (client) =>
        notificationService.requestNotification(req.body || {}, req.ctx, client)
      );
      res.status(r.ok ? 201 : 400).json(Object.assign({ requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  router.get('/', requirePermission('notifications.read'), async (req, res, next) => {
    try {
      const rows = await notificationService.list(req.ctx, { status: req.query.status, limit: parseInt(req.query.limit || '100', 10) });
      res.json({ ok: true, notifications: rows, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  router.get('/:id', requirePermission('notifications.read'), async (req, res, next) => {
    try {
      const row = await notificationService.findById(req.params.id, req.ctx);
      if (!row) return res.status(404).json({ error: 'not_found', requestId: req.ctx.requestId });
      res.json({ ok: true, notification: row, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  router.post('/send/run', requirePermission('notifications.send'), async (req, res, next) => {
    try {
      const limit = parseInt((req.body && req.body.limit) || 25, 10);
      const r = await withTenant(req.ctx.tenantId, (client) =>
        notificationService.sendPending({ limit, client })
      );
      res.json(Object.assign({ ok: true, requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
