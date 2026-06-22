'use strict';

/**
 * APIGateway (Phase 18) - the central request governance pipeline. Every
 * governed request passes, in order:
 *   1. Authentication (AuthService.validate)
 *   2. Request context assembly (+ tracing id)
 *   3. RBAC / Policy validation (PolicyEngine)
 *   4. Property isolation (enforced inside PolicyEngine)
 *   5. Rate limiting (RateLimiterEngine)
 *   6. Audit logging injection (AuditLogAggregator + LogEngine)
 * then the handler runs with the assembled context.
 *
 * Returns { status, body, context? }. Never mutates upstream state.
 */

function buildAPIGateway({ authService, policyEngine, rateLimiter, contextEngine, audit, log, trace } = {}) {
  if (!authService || !policyEngine || !rateLimiter || !contextEngine) throw new Error('APIGateway: dependencies required');

  async function handle(request = {}, handler) {
    const { token, propertyId, permission, endpointCategory = 'default', requestId } = request;

    // 1. Authentication
    const auth = await authService.validate(token);
    if (!auth.ok) return { status: 401, body: { error: auth.error } };
    const principal = auth.principal;

    // 2. Context (+ trace)
    const context = await contextEngine.build({ principal, propertyId, requestId, sessionId: auth.sessionId });
    if (trace) trace.start(context.requestId, { correlationId: context.requestId });

    // 3/4. RBAC + property isolation
    const decision = policyEngine.evaluate(principal, { permission, propertyId });
    if (decision.decision !== 'ALLOW') {
      if (audit) await audit.ingest({ type: 'authz.denied', propertyId, userId: principal.userId, permission, reason: decision.reason });
      return { status: 403, body: { error: 'forbidden', reason: decision.reason } };
    }

    // 5. Rate limiting (per user + property + endpoint category)
    const key = [principal.userId, propertyId || '-', endpointCategory].join('|');
    const rl = rateLimiter.check(key, request.rateLimit || {});
    if (!rl.allowed) return { status: 429, body: { error: 'rate_limited', retryAfterMs: rl.retryAfterMs } };

    // 6. Audit + structured log injection
    if (audit) await audit.ingest({ type: 'authz.allowed', propertyId, userId: principal.userId, permission, correlationId: context.requestId });
    if (log) log.info({ eventType: 'request', module: 'gateway', propertyId, userId: principal.userId, correlationId: context.requestId, permission });

    let body;
    try { body = handler ? await handler(context) : { ok: true }; }
    catch (e) { if (log) log.error({ eventType: 'handler_error', module: 'gateway', correlationId: context.requestId, error: String(e.message || e) }); return { status: 500, body: { error: 'handler_error' }, context }; }
    finally { if (trace) trace.end(context.requestId); }

    return { status: 200, body, context };
  }

  return { handle };
}

module.exports = { buildAPIGateway };
