'use strict';

const express    = require('express');
const router     = express.Router();
const commandBus = require('../core/commandBus');

/**
 * POST /api/core/commands/:name
 *   body: command input JSON
 *
 * Dispatches the named command through the command bus. The bus always runs
 * the audit pipeline - even for unregistered commands - so a command.denied
 * row is always written to audit_events on miss.
 *
 * Response shape mirrors the command outcome:
 *   200 { ok:true,  result, ... }
 *   400 { ok:false, error:'command_not_registered' | 'tenant_required' | ... }
 */
router.post('/commands/:name', async (req, res, next) => {
  try {
    const outcome = await commandBus.dispatch(req.params.name, req.body || {}, req.ctx);
    const status  = outcome.ok ? 200 : 400;
    res.status(status).json(Object.assign({ requestId: req.ctx.requestId }, outcome));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/core/commands -> list registered commands. Useful for the
 * frontend coverage dashboard and for OpenAPI generation later.
 */
router.get('/commands', (req, res) => {
  res.json({ commands: commandBus.list(), requestId: req.ctx.requestId });
});

/**
 * Anything else under /api/core/* is a stub - the route exists so the
 * frontend doesn't 404, but no handler is registered yet.
 */
router.all('/*', (req, res) => {
  res.status(501).json({
    module: 'core',
    stub:   true,
    message: 'phase-1 stub - real handler arrives in phase 2+',
    path: req.originalUrl,
    requestId: req.ctx.requestId
  });
});

module.exports = router;
