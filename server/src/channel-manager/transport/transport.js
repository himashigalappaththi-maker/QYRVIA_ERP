'use strict';

/**
 * Channel transports (Phase 24 B8-B3).
 *
 * A transport is how an adapter actually DELIVERS an outbound request:
 *   send(req) -> { ok, status, ackId?, error? }   req = { channel, op, endpoint, payload }
 *
 * - InProcessTransport: QTCN's internal, zero-network delivery (loopback sink).
 *   "Real" connectivity for QYRVIA's own distribution engine WITHOUT any external
 *   network call.
 * - HttpTransport: real HTTP for third-party OTAs. DISABLED BY DEFAULT - send()
 *   refuses unless explicitly enabled with an endpoint, so no external network
 *   call can happen in tests or default runtime (wired for B8-B5).
 */

function buildInProcessTransport({ sink } = {}) {
  const deliveries = sink || [];
  let seq = 0;
  return {
    kind: 'in-process',
    deliveries,
    async health() { return { ok: true, kind: 'in-process' }; },
    async send({ channel, op, payload } = {}) {
      const ackId = 'ack_' + (++seq);
      deliveries.push({ ackId, channel, op, payload, at: Date.now() });
      return { ok: true, status: 200, ackId };
    },
    async close() {}
  };
}

function buildHttpTransport({ enabled = false, fetchImpl, timeoutMs = 10000 } = {}) {
  return {
    kind: 'http',
    enabled,
    async health() { return { ok: !!enabled, kind: 'http', enabled }; },
    async send(req = {}) {
      if (!enabled) return { ok: false, status: 0, error: 'transport_disabled' }; // default: no network
      if (!req.endpoint) return { ok: false, status: 0, error: 'endpoint_required' };
      const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) return { ok: false, status: 0, error: 'no_fetch_impl' };
      const res = await f(req.endpoint, { method: 'POST', headers: req.headers || {}, body: JSON.stringify(req.payload || {}) });
      return { ok: !!res.ok, status: res.status };
    },
    async close() {}
  };
}

module.exports = { buildInProcessTransport, buildHttpTransport };
