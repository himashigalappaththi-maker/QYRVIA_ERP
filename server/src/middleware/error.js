'use strict';

const logger = require('../config/logger');
const env    = require('../config/env');

/**
 * Single error response shape. Stack traces are never returned to clients
 * outside development. Every error response carries the request_id.
 */
function notFound(req, res, _next) {
  res.status(404).json({
    error: 'not_found',
    path:  req.originalUrl,
    requestId: req.requestId
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  logger.error({ err, status, path: req.originalUrl, request_id: req.requestId }, '[error] handler');
  const body = {
    error:     err.code || 'internal_error',
    detail:    err.message || 'unexpected server error',
    requestId: req.requestId
  };
  if (env.NODE_ENV !== 'production' && err.stack) body.stack = err.stack.split('\n').slice(0, 6);
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
