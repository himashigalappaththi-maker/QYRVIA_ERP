'use strict';

const pino = require('pino');
const env  = require('./env');

/**
 * Base logger. Every log line carries `service` + `env`. Request-scoped child
 * loggers are created by middleware/requestId and carry `request_id`,
 * `tenant_id`, `property_id`.
 */
const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'qyrvia-server',
    env: env.NODE_ENV
  },
  // ISO timestamps make audit correlation simpler than pino's default unix-ms.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Don't bury secrets in logs - redact common offenders even though Phase 1
  // doesn't yet handle auth.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.secret', '*.token'],
    censor: '[REDACTED]'
  }
});

module.exports = logger;
