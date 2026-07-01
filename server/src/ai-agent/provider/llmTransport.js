'use strict';

/**
 * LLM transport (Phase 27.1) - the vendor wire boundary. NO vendor lock-in: the
 * agent/provider depend on `chat(messages, { apiKey })`, not on any specific API.
 * Default DISABLED -> `chat()` short-circuits before any network call, so nothing
 * is contacted in tests/default. A real call uses an OpenAI-compatible POST; the
 * response parser also accepts a bare `{ content }` for vendor neutrality.
 *
 * The API key is passed per-call (Authorization header) and is NEVER placed in the
 * message body or logged.
 */

function buildHttpLlmTransport({ endpoint, model = 'gpt-4o-mini', fetchImpl, enabled = false, timeoutMs = 10000 } = {}) {
  return {
    kind: 'http-llm',
    enabled,
    model,
    endpoint: endpoint || null,
    async chat(messages, { apiKey } = {}) {
      if (!enabled) return { ok: false, error: 'llm_disabled' };       // default: no network
      if (!endpoint) return { ok: false, error: 'endpoint_required' };
      const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) return { ok: false, error: 'no_fetch' };
      try {
        const res = await f(endpoint, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
          body: JSON.stringify({ model, messages })
        });
        if (!res.ok) return { ok: false, error: 'llm_http_' + res.status };
        const json = await res.json();
        const content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || (json && json.content) || '';
        return { ok: true, content };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
  };
}

module.exports = { buildHttpLlmTransport };
