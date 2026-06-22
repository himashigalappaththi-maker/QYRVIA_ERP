'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');

function build({ webhookService }) {
  const router = express.Router();
  if (!webhookService) return router;

  router.get('/', requirePermission('webhook.manage'), async (req, res, next) => {
    try {
      const rows = await webhookService.listEndpoints(req.ctx);
      res.json({ ok: true, endpoints: rows, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  router.post('/', requirePermission('webhook.manage'), async (req, res, next) => {
    try {
      const r = await webhookService.registerEndpoint(req.body || {}, req.ctx);
      res.status(r.ok ? 201 : 400).json(Object.assign({ requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  router.delete('/:id', requirePermission('webhook.manage'), async (req, res, next) => {
    try {
      const r = await webhookService.disableEndpoint(req.params.id, req.ctx);
      res.json(Object.assign({ requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  // POST /api/webhooks/deliveries/run  -- operator-triggered delivery loop
  router.post('/deliveries/run', requirePermission('webhook.manage'), async (req, res, next) => {
    try {
      const limit = parseInt((req.body && req.body.limit) || 25, 10);
      const r = await webhookService.deliverPending({ limit });
      res.json(Object.assign({ ok: true, requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
