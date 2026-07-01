'use strict';

/**
 * Correlation context (Phase 32). AsyncLocalStorage-backed per-request context
 * that propagates correlationId + requestId + tenant/property/user/session
 * through middleware, services, repositories, db helpers and jobs WITHOUT being
 * threaded by hand and WITHOUT leaking across pooled requests (each async chain
 * gets its own store; pooled DB connection reuse never carries the store).
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const als = new AsyncLocalStorage();
const HEADER_CORRELATION = 'x-correlation-id';
const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** Current context (or {} when outside any run). */
function getContext() { return als.getStore() || {}; }

/** Run fn with a context bound for the whole async subtree. */
function runWithContext(ctx, fn) { return als.run(Object.freeze({ ...ctx }), fn); }

/** Shallow fields useful for logs/metrics from the active context. */
function logFields() {
  const c = getContext();
  return {
    correlation_id: c.correlationId || null,
    request_id: c.requestId || null,
    tenant_id: c.tenantId || null,
    property_id: c.propertyId || null,
    user_id: c.userId || null,
    session_id: c.sessionId || null
  };
}

/**
 * Express middleware: derive correlationId (client header or = requestId),
 * bind the context, echo X-Correlation-Id, and run the rest of the request
 * inside the ALS store. Mount AFTER requestId and identityContext so it can
 * read req.requestId / req.ctx (it also re-reads tenant/property lazily).
 */
function middleware() {
  return function (req, res, next) {
    const incoming = req.get(HEADER_CORRELATION);
    const correlationId = (incoming && ID_RE.test(incoming)) ? incoming : (req.requestId || crypto.randomUUID());
    res.setHeader('X-Correlation-Id', correlationId);
    const ctx = {
      correlationId,
      requestId: req.requestId || correlationId,
      tenantId: (req.ctx && req.ctx.tenantId) || req.tenantId || null,
      propertyId: (req.ctx && req.ctx.propertyId) || req.propertyId || null,
      userId: (req.ctx && req.ctx.actorId) || (req.user && req.user.sub) || null,
      sessionId: (req.user && req.user.session_id) || null,
      startedAt: Date.now()
    };
    req.correlationId = correlationId;
    runWithContext(ctx, () => next());
  };
}

module.exports = { als, getContext, runWithContext, logFields, middleware, HEADER_CORRELATION };
