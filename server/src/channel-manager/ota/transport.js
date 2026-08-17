'use strict';

/**
 * OTA Transport abstraction (Phase 30.2) - production-grade outbound delivery.
 *
 * Additive: this layer wraps a PROVIDER (codec + auth header mapping + error/retry
 * classification) and an injected HTTP transport. It is NOT wired into the canonical
 * registry/adapters here (preserves Phase 28); a later phase composes it.
 *
 * One delivery = rate-limit gate -> resolve auth headers (AuthStrategy; never a raw
 * secret) -> codec.encode -> http.send -> codec.decode -> normalized acknowledgement
 * -> retry on RETRYABLE failures (backoff via the shared RetryPolicy). The HTTP
 * transport is INJECTED and DEFAULT-DISABLED, so no external network call happens in
 * tests or default runtime ("no live calls, no certification claims").
 */

const { RetryPolicy } = require('../core/sync/RetryPolicy');

/**
 * Phase 68A — QYRVIA-SIDE outbound correlation metadata (idempotency
 * propagation, instruction 032 Section 14).
 *
 * This is deliberately NOT a claim that any provider treats this header as
 * an idempotency guarantee — no verified Booking.com (or any other
 * provider's) protocol documentation exists in this repository confirming
 * such support, and inventing one would be exactly the "invented provider
 * idempotency claim" the instruction forbids. This header exists purely so
 * QYRVIA's own logs/traces can correlate a request with the durable ledger
 * row that authorized it (src/ari/dispatch/ariChannelDeliveryStore.js); the
 * ACTUAL duplicate-prevention boundary is that durable ledger, checked
 * BEFORE this transport is ever called (see ariChannelDispatcher.js) — never
 * this header.
 */
const CORRELATION_REQUEST_HEADER = 'X-Qyrvia-Correlation-Id';

/** Normalized acknowledgement - the single shape every provider decodes into. */
function normalizeAck(a = {}) {
  return {
    ok: !!a.ok,
    ackId: a.ackId != null ? a.ackId : null,
    status: a.status != null ? a.status : 0,
    retryable: !!a.retryable,
    errors: Array.isArray(a.errors) ? a.errors : (a.errors ? [a.errors] : []),
    raw: a.raw != null ? a.raw : null
  };
}

/** Per-channel rate limiter (min interval). clock + sleep injectable for tests. */
function buildRateLimiter({ minIntervalMs = 0, clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = 0;
  return {
    minIntervalMs,
    async gate() {
      if (!minIntervalMs) return;
      const wait = last + minIntervalMs - clock();
      if (wait > 0) await sleep(wait);
      last = clock();
    }
  };
}

/** Default HTTP transport: DISABLED (no network). Returns a transport_disabled result. */
function buildDisabledHttp() {
  return { kind: 'disabled', enabled: false, async send() { return { ok: false, status: 0, error: 'transport_disabled' }; }, async health() { return { ok: false, kind: 'disabled' }; } };
}

function buildOtaTransport({ provider, http, auth, retryPolicy, rateLimiter, sleep, clock } = {}) {
  if (!provider || !provider.channel) throw new Error('otaTransport: provider with channel required');
  const send = http || buildDisabledHttp();
  const retry = retryPolicy || new RetryPolicy({ maxAttempts: 4, baseMs: 50, factor: 2, maxMs: 5000 });
  const limiter = rateLimiter || buildRateLimiter({ minIntervalMs: (provider.rateLimit && provider.rateLimit.minIntervalMs) || 0, clock, sleep });
  const _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function authHeaders() {
    if (!auth || typeof auth.getAuthHeaders !== 'function') return {};
    try { return (await auth.getAuthHeaders()) || {}; } catch (_) { return {}; }
  }

  async function deliver(op, encoded, ctx) {
    let attempts = 0;
    let ack = null;
    // Bounded, non-secret correlation value only — see CORRELATION_REQUEST_HEADER's
    // header comment. Absent when the caller supplies none (fully backward
    // compatible with every pre-Phase-68A caller of pushRateUpdate/pushAvailability/
    // pushReservationAck that never passed one).
    const correlationId = ctx && ctx.correlationId != null ? String(ctx.correlationId).slice(0, 200) : null;
    while (true) {
      attempts += 1;
      await limiter.gate();
      const headers = await authHeaders();
      if (correlationId) headers[CORRELATION_REQUEST_HEADER] = correlationId;
      // Phase 69A: static, non-auth headers a provider's wire format
      // requires (e.g. Booking.com's Content-Type/Accept-Version for its
      // XML availability endpoint). Purely additive — a provider with no
      // headersFor() (every provider before this phase) is unaffected, and
      // a throwing headersFor() must never block delivery over a header
      // builder defect.
      if (typeof provider.headersFor === 'function') {
        try { Object.assign(headers, provider.headersFor(op, ctx) || {}); } catch (_) { /* never block delivery */ }
      }
      let raw;
      try {
        raw = await send.send({ channel: provider.channel, op, endpoint: provider.endpointFor ? provider.endpointFor(op, ctx) : null, headers, payload: encoded });
      } catch (e) {
        raw = { ok: false, status: 0, error: String((e && e.message) || e) };
      }
      ack = Object.assign(normalizeAck(provider.decodeAck(op, raw)), { attempts, op, channel: provider.channel });
      if (ack.ok) return ack;
      if (!ack.retryable || !retry.shouldRetry(attempts)) return ack;
      await _sleep(retry.nextDelay(attempts));
    }
  }

  return {
    channel: provider.channel,
    httpEnabled: !!send.enabled,
    async pushRateUpdate(rate, ctx = {}) { return deliver('pushRateUpdate', provider.encodeRateUpdate(rate, ctx), ctx); },
    async pushAvailability(inv, ctx = {}) { return deliver('pushAvailability', provider.encodeAvailability(inv, ctx), ctx); },
    async pushReservationAck(res, ctx = {}) { return deliver('pushReservationAck', provider.encodeReservationAck(res, ctx), ctx); },
    async health() {
      const h = send.health ? await send.health() : { ok: !!send.enabled };
      return { ok: !!h.ok, channel: provider.channel, transport: send.kind, enabled: !!send.enabled };
    }
  };
}

module.exports = { buildOtaTransport, buildRateLimiter, buildDisabledHttp, normalizeAck, CORRELATION_REQUEST_HEADER };
