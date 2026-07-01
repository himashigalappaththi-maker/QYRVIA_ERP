'use strict';

/**
 * HTTP request metrics (Phase 33). An additive Express middleware that counts
 * requests + latency and tracks in-flight requests, plus a route normaliser
 * that keeps the {route} label LOW-CARDINALITY: query strings are dropped and
 * any variable segment (uuid / numeric id / long hex / overlong token) is
 * collapsed to ":id". No raw paths, no tenant/property/user/request ids, no
 * query values ever reach a metric label.
 */

const { getObservability } = require('./index');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE  = /^[0-9a-f]{16,}$/i;     // long hex tokens / hashes
const NUM_RE  = /^\d+$/;                // numeric ids
const MAX_SEGMENTS = 6;                 // hard cap on path depth in the label

/** Collapse a variable-looking path segment to ":id". */
function isVariable(seg) {
  return UUID_RE.test(seg) || HEX_RE.test(seg) || NUM_RE.test(seg) || seg.length > 32;
}

/**
 * Normalise a request path to a bounded, id-free route label.
 *   /api/pms/rooms/3f...uuid -> /api/pms/rooms/:id
 *   /api/iam/users/42?x=1    -> /api/iam/users/:id
 */
function normalizeRoute(rawPath) {
  let p = String(rawPath || '/');
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  if (p === '' || p === '/') return '/';
  const segs = p.split('/').filter(Boolean).slice(0, MAX_SEGMENTS)
    .map((s) => (isVariable(s) ? ':id' : s));
  return '/' + segs.join('/');
}

/**
 * Build the middleware. `obs` is injectable for tests; production uses the
 * process-wide singleton. Recording is fully guarded so telemetry can never
 * break or delay a response, and the active-request gauge is decremented
 * exactly once (on whichever of finish/close fires first) so it cannot leak on
 * aborted connections.
 */
function httpMetricsMiddleware(obs = getObservability()) {
  return function httpMetrics(req, res, next) {
    const start = process.hrtime.bigint();
    try { obs.metrics.httpActiveInc(); } catch (_) { /* never block the request */ }

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try {
        obs.metrics.httpActiveDec();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        obs.metrics.httpRequest(req.method, normalizeRoute(req.originalUrl || req.url), res.statusCode, ms);
      } catch (_) { /* swallow telemetry errors */ }
    };

    res.on('finish', settle);
    res.on('close', settle);
    next();
  };
}

module.exports = { httpMetricsMiddleware, normalizeRoute };
