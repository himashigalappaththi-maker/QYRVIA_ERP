'use strict';

const express = require('express');

const logger    = require('./config/logger');
const requestId = require('./middleware/requestId');
const apiBuild  = require('./routes/api');
const { notFound, errorHandler } = require('./middleware/error');
const { securityHeaders, sanitizeJsonBody } = require('./middleware/security');

const eventBus = require('./core/eventBus');

// Minimal inline request logger - keeps pino as our only logging dep.
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info({
      request_id: req.requestId,
      tenant_id:  req.tenantId || null,
      method:     req.method,
      path:       req.originalUrl,
      status:     res.statusCode,
      duration_ms: Math.round(ms * 100) / 100
    }, 'http');
  });
  next();
}

/**
 * Express app factory. Tests construct an app with a custom DB facade;
 * src/index.js wires the real pg pool.
 *
 * @param {object} deps
 * @param {object} deps.db       - { ping(): Promise<boolean>, insertAuditEvent(ev): Promise<void> }
 * @returns Express app
 */
function createApp(deps = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  if (deps.db) app.set('db', deps.db);

  // Wire the event bus to the supplied DB facade (or leave unwired - bus
  // will warn but not crash).
  eventBus.init({ db: deps.db });

  // 1. security headers + requestId + request logger
  app.use(securityHeaders());
  app.use(requestId);
  app.use(requestLogger);

  // 2. JSON body parser - 256 KB cap; followed by sanitiser pass.
  app.use(express.json({ limit: '256kb' }));
  app.use(sanitizeJsonBody({ maxStringLen: 64_000, maxDepth: 12 }));

  // 3. Root-level health endpoints (k8s/load-balancer probes; no /api prefix).
  app.get('/health/live',  (_req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/health/ready', async (req, res) => {
    const dbFacade = req.app.get('db');
    if (!dbFacade || typeof dbFacade.ping !== 'function') return res.status(503).json({ db: 'down', error: 'db_client_unavailable' });
    try { const ok = await dbFacade.ping(); return ok ? res.status(200).json({ db: 'ok' }) : res.status(503).json({ db: 'down' }); }
    catch (err) { return res.status(503).json({ db: 'down', error: err.message }); }
  });

  // 4. /api surface - apiBuild assembles the full router with DI
  app.use('/api', apiBuild.build(deps));

  // 4. 404 + error handlers last
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
