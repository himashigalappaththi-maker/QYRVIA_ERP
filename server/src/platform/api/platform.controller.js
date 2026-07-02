'use strict';

/** Platform admin / integration / enterprise HTTP controller (Phase 18). */

const { errorField } = require('../../middleware/errorEnvelope');

function buildController({ platform }) {
  const ctxOf = (req) => req.ctx || {};
  const ok = (res, req, result) => res.json({ ok: true, result, requestId: ctxOf(req).requestId });
  // READ envelope (Phase 23 R1): GET handlers emit { ok, data }; writes keep ok()/{ ok, result }.
  const okRead = (res, req, data) => res.json({ ok: true, data, requestId: ctxOf(req).requestId });
  const fail = (res, req, code, status = 400) => res.status(status).json({ ok: false, error: errorField(code), requestId: ctxOf(req).requestId });

  return {
    metrics(req, res) { okRead(res, req, platform.metrics.snapshot()); },
    logs(req, res) { okRead(res, req, platform.log.query({ level: req.query.level, module: req.query.module, correlationId: req.query.correlation_id })); },
    audit(req, res) { okRead(res, req, platform.audit.list({ propertyId: ctxOf(req).propertyId, type: req.query.type })); },

    integrationsStatus(req, res) { okRead(res, req, platform.integrations.list()); },
    async webhook(req, res, next) {
      try {
        const b = req.body || {};
        const result = platform.webhooks.receive({ source: b.source, payload: b.payload, signature: b.signature, idempotencyKey: b.idempotency_key, secret: b.secret });
        return result.ok ? ok(res, req, result) : fail(res, req, result.error || 'webhook_rejected');
      } catch (e) { next(e); }
    },
    async sync(req, res, next) {
      try {
        const name = (req.body || {}).adapter;
        if (!name) return fail(res, req, 'adapter_required');
        const adapter = platform.adapters.get(name);
        const out = await adapter.syncReservations(req.body || {});
        ok(res, req, { adapter: name, synced: out || true });
      } catch (e) { if (/unknown_adapter/.test(e.message)) return fail(res, req, e.message); next(e); }
    },

    properties(req, res) { okRead(res, req, platform.properties.list()); },
    analytics(req, res) { okRead(res, req, platform.analytics.aggregate()); },
    config(req, res) { okRead(res, req, platform.config.getGlobal()); }
  };
}

module.exports = { buildController };
