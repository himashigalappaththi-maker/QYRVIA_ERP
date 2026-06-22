'use strict';

/**
 * TraceEngine (Phase 18) - lightweight distributed-trace model. A trace is keyed
 * by a correlationId (the request id) and accumulates spans across modules.
 */

function buildTraceEngine({ clock } = {}) {
  const now = clock || (() => Date.now());
  const traces = new Map();   // traceId -> { traceId, correlationId, startedAt, endedAt, spans[] }

  return {
    start(traceId, { correlationId } = {}) {
      const t = { traceId, correlationId: correlationId || traceId, startedAt: now(), endedAt: null, spans: [] };
      traces.set(traceId, t);
      return t;
    },
    span(traceId, name, { startedAt, endedAt, module } = {}) {
      const t = traces.get(traceId);
      if (!t) return null;
      const s = { name, module: module || null, startedAt: startedAt != null ? startedAt : now(), endedAt: endedAt != null ? endedAt : now() };
      s.durationMs = s.endedAt - s.startedAt;
      t.spans.push(s);
      return s;
    },
    end(traceId) { const t = traces.get(traceId); if (t) t.endedAt = now(); return t || null; },
    getTrace(traceId) { const t = traces.get(traceId); return t ? JSON.parse(JSON.stringify(t)) : null; },
    findByCorrelation(correlationId) {
      return Array.from(traces.values()).filter((t) => t.correlationId === correlationId).map((t) => JSON.parse(JSON.stringify(t)));
    }
  };
}

module.exports = { buildTraceEngine };
