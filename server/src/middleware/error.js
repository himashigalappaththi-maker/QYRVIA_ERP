'use strict';

const logger = require('../config/logger');
const env    = require('../config/env');
const { errorField } = require('./errorEnvelope');

/**
 * Single error response shape. Stack traces are never returned to clients
 * outside development. Every error response carries the request_id.
 */
function notFound(req, res, _next) {
  res.status(404).json({
    error: errorField('not_found', 'not_found'),
    path:  req.originalUrl,
    requestId: req.requestId
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  logger.error({ err, status, path: req.originalUrl, request_id: req.requestId }, '[error] handler');
  const code    = err.code || 'internal_error';
  const message = err.message || 'unexpected server error';
  const body = { error: errorField(code, message), requestId: req.requestId };
  // Legacy string mode keeps the separate `detail` field; object mode folds it into error.message.
  if (env.ERROR_ENVELOPE !== 'object') body.detail = message;
  if (env.NODE_ENV !== 'production' && err.stack) body.stack = err.stack.split('\n').slice(0, 6);
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
