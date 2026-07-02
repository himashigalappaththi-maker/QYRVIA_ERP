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
    while (true) {
      attempts += 1;
      await limiter.gate();
      const headers = await authHeaders();
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

module.exports = { buildOtaTransport, buildRateLimiter, buildDisabledHttp, normalizeAck };
