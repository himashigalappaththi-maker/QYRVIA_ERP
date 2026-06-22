'use strict';

const express = require('express');
const { requirePermission } = require('../middleware/authorization');

function build({ connectorRegistry }) {
  const router = express.Router();
  if (!connectorRegistry) return router;

  // GET /api/connectors - list registered connector types (global)
  router.get('/', async (req, res, next) => {
    try {
      const rows = await connectorRegistry.list(req.ctx);
      res.json({ ok: true, connectors: rows, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  // GET /api/connectors/:code/config - this tenant's configuration record
  router.get('/:code/config', requirePermission('connector.configure'), async (req, res, next) => {
    try {
      const cfg = await connectorRegistry.getConfig(req.params.code, req.ctx);
      res.json({ ok: true, config: cfg, requestId: req.ctx.requestId });
    } catch (err) { next(err); }
  });

  // PUT /api/connectors/:code/config  body: { enabled, config_json }
  router.put('/:code/config', requirePermission('connector.configure'), async (req, res, next) => {
    try {
      const { enabled, config_json } = req.body || {};
      const r = await connectorRegistry.configureConnector(req.params.code, { enabled, config_json }, req.ctx);
      res.status(r.ok ? 200 : 400).json(Object.assign({ requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  // POST /api/connectors/:code/probe
  router.post('/:code/probe', requirePermission('connector.configure'), async (req, res, next) => {
    try {
      const r = await connectorRegistry.probeConnector(req.params.code, req.ctx);
      res.json(Object.assign({ ok: true, requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  // POST /api/connectors/:code/health
  router.post('/:code/health', requirePermission('connector.configure'), async (req, res, next) => {
    try {
      const r = await connectorRegistry.healthCheck(req.params.code, req.ctx);
      res.json(Object.assign({ ok: true, requestId: req.ctx.requestId }, r));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { build };
