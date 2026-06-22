'use strict';

/**
 * platformMiddleware (Phase 18) - additive Express middleware for the /platform
 * surface. It records metrics + a structured log per request and tags a
 * correlation id. It assumes the existing protected chain already authenticated
 * the request (it does not replace it), keeping full backward compatibility.
 */

function buildPlatformMiddleware({ platform } = {}) {
  if (!platform) throw new Error('platformMiddleware: platform required');
  return function platformObservability(req, res, next) {
    const correlationId = (req.ctx && req.ctx.requestId) || req.requestId || null;
    const start = Date.now();
    platform.metrics.increment('platform_requests_total', 1, { path: req.path });
    res.on('finish', () => {
      platform.metrics.timing('platform_request_ms', Date.now() - start);
      platform.log.info({ eventType: 'http', module: 'platform', correlationId,
        propertyId: (req.ctx && req.ctx.propertyId) || null, status: res.statusCode, path: req.originalUrl });
    });
    next();
  };
}

module.exports = { buildPlatformMiddleware };
