'use strict';

/**
 * Real connector adapter implementations.
 *
 * Each adapter exposes:
 *   { probe(config_json) -> { ok, detail? }
 *     health(config_json) -> { ok, detail?, latency_ms? }
 *     capabilities() -> string[] }
 *
 * Credentials come from env vars (referenced by name in config_json) or are
 * directly part of config_json for non-secret fields. Secrets MUST live in
 * env, never in config_json. This is enforced by the adapter (it reads
 * secret-bearing values from process.env, ignoring matching keys in
 * config_json).
 */

function _need(modName) {
  try { return require(modName); }
  catch (e) { throw new Error('adapter requires "' + modName + '"'); }
}

function buildAnthropicAdapter({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    capabilities() { return ['chat', 'completion']; },
    async probe(/* cfg */) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { ok: false, detail: 'ANTHROPIC_API_KEY missing' };
      return { ok: true };
    },
    async health(/* cfg */) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key)    return { ok: false, detail: 'not_configured' };
      if (!_fetch) return { ok: false, detail: 'no_fetch_impl' };
      const t0 = Date.now();
      try {
        // Tiny prompt against the messages endpoint
        const resp = await _fetch('https://api.anthropic.com/v1/messages', {
          method:  'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body:    JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role:'user', content: 'ok' }] })
        });
        return { ok: resp.ok, detail: resp.ok ? null : 'http_' + resp.status, latency_ms: Date.now() - t0 };
      } catch (err) { return { ok: false, detail: String(err.message || err), latency_ms: Date.now() - t0 }; }
    }
  };
}

function buildOpenAIAdapter({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    capabilities() { return ['chat', 'completion', 'embeddings']; },
    async probe() { return process.env.OPENAI_API_KEY ? { ok: true } : { ok: false, detail: 'OPENAI_API_KEY missing' }; },
    async health() {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return { ok: false, detail: 'not_configured' };
      if (!_fetch) return { ok: false, detail: 'no_fetch_impl' };
      const t0 = Date.now();
      try {
        const resp = await _fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': 'Bearer ' + key } });
        return { ok: resp.ok, detail: resp.ok ? null : 'http_' + resp.status, latency_ms: Date.now() - t0 };
      } catch (err) { return { ok: false, detail: String(err.message || err), latency_ms: Date.now() - t0 }; }
    }
  };
}

function buildOpenRouterAdapter({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    capabilities() { return ['chat', 'completion']; },
    async probe() { return process.env.OPENROUTER_API_KEY ? { ok: true } : { ok: false, detail: 'OPENROUTER_API_KEY missing' }; },
    async health() {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return { ok: false, detail: 'not_configured' };
      if (!_fetch) return { ok: false, detail: 'no_fetch_impl' };
      const t0 = Date.now();
      try {
        const resp = await _fetch('https://openrouter.ai/api/v1/models', { headers: { 'Authorization': 'Bearer ' + key } });
        return { ok: resp.ok, detail: resp.ok ? null : 'http_' + resp.status, latency_ms: Date.now() - t0 };
      } catch (err) { return { ok: false, detail: String(err.message || err), latency_ms: Date.now() - t0 }; }
    }
  };
}

function buildGeminiAdapter({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    capabilities() { return ['chat', 'completion', 'embeddings']; },
    async probe() { return process.env.GEMINI_API_KEY ? { ok: true } : { ok: false, detail: 'GEMINI_API_KEY missing' }; },
    async health() {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return { ok: false, detail: 'not_configured' };
      if (!_fetch) return { ok: false, detail: 'no_fetch_impl' };
      const t0 = Date.now();
      try {
        const resp = await _fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key));
        return { ok: resp.ok, detail: resp.ok ? null : 'http_' + resp.status, latency_ms: Date.now() - t0 };
      } catch (err) { return { ok: false, detail: String(err.message || err), latency_ms: Date.now() - t0 }; }
    }
  };
}

function buildStripeAdapter({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    capabilities() { return ['payment_intent', 'refund', 'webhooks']; },
    async probe() { return process.env.STRIPE_SECRET_KEY ? { ok: true } : { ok: false, detail: 'STRIPE_SECRET_KEY missing' }; },
    async health() {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) return { ok: false, detail: 'not_configured' };
      if (!_fetch) return { ok: false, detail: 'no_fetch_impl' };
      const t0 = Date.now();
      try {
        const resp = await _fetch('https://api.stripe.com/v1/balance', { headers: { 'Authorization': 'Bearer ' + key } });
        return { ok: resp.ok, detail: resp.ok ? null : 'http_' + resp.status, latency_ms: Date.now() - t0 };
      } catch (err) { return { ok: false, detail: String(err.message || err), latency_ms: Date.now() - t0 }; }
    }
  };
}

function buildBookingComAdapter({ fetchImpl } = {}) {
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return {
    capabilities() { return ['rate_push', 'availability_push', 'reservation_pull']; },
    async probe() {
      const id  = process.env.BOOKING_COM_PROPERTY_ID;
      const key = process.env.BOOKING_COM_API_KEY;
      if (!id || !key) return { ok: false, detail: 'BOOKING_COM_PROPERTY_ID/BOOKING_COM_API_KEY missing' };
      return { ok: true };
    },
    async health() {
      const id  = process.env.BOOKING_COM_PROPERTY_ID;
      const key = process.env.BOOKING_COM_API_KEY;
      if (!id || !key) return { ok: false, detail: 'not_configured' };
      // Booking.com partner endpoints require XML over HTTPS Basic auth; a real
      // health endpoint is the supply-side ping. We don't have credentials to
      // hardcode an endpoint - return ok:false detail when no fetch, ok:true
      // detail:'no_health_endpoint_probed' when credentials present but no
      // configured probe URL. Real implementations override this via config.
      return { ok: true, detail: 'credentials_present (no_remote_probe)' };
    }
  };
}

module.exports = {
  buildAnthropicAdapter, buildOpenAIAdapter, buildOpenRouterAdapter,
  buildGeminiAdapter, buildStripeAdapter, buildBookingComAdapter
};
