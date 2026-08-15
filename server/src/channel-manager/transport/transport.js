'use strict';

/**
 * Channel transports (Phase 24 B8-B3; hardened Phase 68A).
 *
 * A transport is how an adapter actually DELIVERS an outbound request:
 *   send(req) -> { ok, status, body, correlationId?, error? }
 *   req = { channel, op, endpoint, payload }
 *
 * - InProcessTransport: QYRVIA Connect (QYRVIA_CONNECT) in-process delivery — no
 *   external network call. Real ARI/booking-event delivery for QYRVIA's owned platform.
 * - HttpTransport: real HTTP for third-party OTAs. DISABLED BY DEFAULT - send()
 *   refuses unless explicitly enabled with an endpoint, so no external network
 *   call can happen in tests or default runtime.
 *
 * PHASE 68A HARDENING — two confirmed defects (instruction 031 audit,
 * Section 12) closed here, in the SHARED transport rather than a second HTTP
 * client:
 *   1. `timeoutMs` used to be accepted and never enforced — a hung fetch
 *      could block forever. Now enforced via AbortController with the
 *      installed Node runtime's native `fetch`/`AbortController` (both
 *      global since Node 18); the timer is ALWAYS cleared (success, error,
 *      or abort) so nothing keeps the event loop alive or double-fires.
 *   2. `send()` used to return only `{ ok, status }` — every provider codec's
 *      decodeAck reads `raw.body.*`, which was therefore always undefined
 *      even when HTTP was enabled. `send()` now returns a bounded, safely
 *      parsed `body` (JSON when present, `null` for an empty or
 *      non-JSON/invalid body — never a thrown parse error) plus, when the
 *      response carries one, a `correlationId` read from a narrow allowlist
 *      of safe headers — never the full header set, and never
 *      Authorization/secret material, which this module never receives to
 *      begin with (headers are request-direction only; see
 *      ota/transport.js's authHeaders()).
 *
 * Also added: HTTPS is now REQUIRED for any endpoint this transport actually
 * contacts (enabled=true path only — a disabled/local/mock transport used in
 * tests never reaches this check because it never leaves the
 * `enabled=false`/no-fetchImpl branches). No automatic retry lives here —
 * ota/transport.js's RetryPolicy already owns retry/backoff; adding a second
 * retry loop here would double the effective attempt count.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB — conservative, ARI acks are small JSON

// Narrow, explicit allowlist. Never forward the full response header set —
// that would risk leaking provider-side session/cookie/internal routing
// values into logs or downstream state.
const CORRELATION_HEADER_NAMES = Object.freeze(['x-request-id', 'x-correlation-id']);

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
      return { ok: true, status: 200, ackId, body: { ackId } };
    },
    async close() {}
  };
}

function readCorrelationId(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  for (const name of CORRELATION_HEADER_NAMES) {
    try {
      const v = headers.get(name);
      if (v) return String(v).slice(0, 200); // bounded — never an unbounded header echo
    } catch (_) { /* a malformed/hostile Headers impl must never throw past this point */ }
  }
  return null;
}

/**
 * Bounded, crash-proof body capture. Never throws: any failure to read or
 * parse the body degrades to `body: null` rather than propagating — a
 * malformed provider response must never take down the delivery attempt
 * before its HTTP status has even been classified.
 */
async function readBoundedBody(res, maxBytes) {
  // Fail closed on an advertised oversized body BEFORE reading anything —
  // but a malformed/hostile Headers implementation must never take down an
  // otherwise-successful response just because ITS one optional bound-check
  // failed; degrade to "no declared length" and fall through to the actual
  // byte-bounded read below instead.
  let declaredLength = NaN;
  if (res && res.headers && typeof res.headers.get === 'function') {
    try { declaredLength = Number(res.headers.get('content-length')); } catch (_) { declaredLength = NaN; }
  }
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { body: null, oversized: true };
  }

  if (typeof res.text === 'function') {
    let text;
    try {
      text = await res.text();
    } catch (_) {
      return { body: null, oversized: false };
    }
    if (text == null || text === '') return { body: null, oversized: false };

    // No trustworthy Content-Length (or none was advertised) — bound the
    // ACTUAL bytes read. An oversized undeclared body is rejected rather
    // than truncated: parsing a truncated JSON document would either throw
    // or, worse, silently yield a half-formed object mistaken for a real ack.
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { body: null, oversized: true };
    }

    try {
      return { body: JSON.parse(text), oversized: false };
    } catch (_) {
      // Tolerate invalid JSON without crashing — the caller sees body: null,
      // exactly like an empty body, and every provider decodeAck already
      // guards with `raw.body && ...` so this degrades to its existing
      // http_<status> fallback path, never a thrown error.
      return { body: null, oversized: false };
    }
  }

  // Fallback for response shapes (real or test-fake) that only implement
  // .json() and not .text() — cannot byte-bound before parsing, but the
  // Content-Length pre-check above still applies when the header is present.
  if (typeof res.json === 'function') {
    try {
      return { body: await res.json(), oversized: false };
    } catch (_) {
      return { body: null, oversized: false };
    }
  }

  return { body: null, oversized: false };
}

function buildHttpTransport({ enabled = false, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  return {
    kind: 'http',
    enabled,
    async health() { return { ok: !!enabled, kind: 'http', enabled }; },
    async send(req = {}) {
      if (!enabled) return { ok: false, status: 0, body: null, error: 'transport_disabled' }; // default: no network
      if (!req.endpoint) return { ok: false, status: 0, body: null, error: 'endpoint_required' };
      // HTTPS enforcement (Section 12/18): a plain-HTTP endpoint is refused
      // BEFORE any network attempt — this is a local, deterministic check,
      // never a network round trip, so it is exercised identically whether
      // or not a real network is reachable.
      if (!/^https:\/\//i.test(String(req.endpoint))) {
        return { ok: false, status: 0, body: null, error: 'https_required' };
      }
      const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) return { ok: false, status: 0, body: null, error: 'no_fetch_impl' };

      const AC = typeof AbortController !== 'undefined' ? AbortController : null;
      const controller = AC ? new AC() : null;
      let timedOut = false;
      const timer = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs)
        : null;

      try {
        const res = await f(req.endpoint, {
          method: 'POST',
          headers: req.headers || {},
          body: JSON.stringify(req.payload || {}),
          signal: controller ? controller.signal : undefined
        });
        const { body, oversized } = await readBoundedBody(res, maxResponseBytes);
        if (oversized) return { ok: false, status: res.status || 0, body: null, error: 'response_too_large' };
        return {
          ok: !!res.ok,
          status: res.status,
          body,
          correlationId: readCorrelationId(res.headers)
        };
      } catch (e) {
        // AbortError from our own timeout is a distinct, clearly-classified
        // outcome (status 0 -> retryable per classifyHttpStatus) rather than
        // an opaque network_error, so operators can tell "the provider never
        // answered in time" from "the connection failed outright".
        if (timedOut || (e && e.name === 'AbortError')) {
          return { ok: false, status: 0, body: null, error: 'timeout' };
        }
        return { ok: false, status: 0, body: null, error: String((e && e.message) || e) };
      } finally {
        // ALWAYS cleared — success, thrown error, or abort. An uncleared
        // timer is exactly the "no hanging fetch, no leaked timer" defect
        // this fix exists to close.
        if (timer) clearTimeout(timer);
      }
    },
    async close() {}
  };
}

module.exports = { buildInProcessTransport, buildHttpTransport, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES };
