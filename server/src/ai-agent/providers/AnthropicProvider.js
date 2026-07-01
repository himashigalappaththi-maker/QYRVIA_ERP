'use strict';

/**
 * AnthropicProvider (Phase 27.1A) - Claude Messages API abstraction. Transport is
 * DEFAULT DISABLED (no network). Key via SecretProvider (x-api-key, execution-time
 * only). Hospitality default: preferred for guest conversations + reservation
 * extraction.
 */

const { buildVendorProvider } = require('./AIProvider');

function buildAnthropicTransport({ endpoint, model = 'claude-3-5-haiku-latest', fetchImpl, enabled = false, version = '2023-06-01' } = {}) {
  return {
    kind: 'anthropic-http', enabled, model, endpoint: endpoint || null,
    async chat(messages, { apiKey } = {}) {
      if (!enabled) return { ok: false, error: 'disabled' };
      if (!endpoint) return { ok: false, error: 'endpoint_required' };
      const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) return { ok: false, error: 'no_fetch' };
      const system = (messages.find((m) => m.role === 'system') || {}).content || '';
      const user = (messages.find((m) => m.role === 'user') || {}).content || '';
      try {
        const res = await f(endpoint, {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json', 'anthropic-version': version }, apiKey ? { 'x-api-key': apiKey } : {}),
          body: JSON.stringify({ model, max_tokens: 512, system, messages: [{ role: 'user', content: user }] })
        });
        if (!res.ok) return { ok: false, error: 'http_' + res.status };
        const json = await res.json();
        const content = (json && json.content && json.content[0] && json.content[0].text) || (json && typeof json.content === 'string' ? json.content : '') || '';
        return { ok: true, content };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
  };
}

function buildAnthropicProvider(opts = {}) {
  const transport = opts.transport || buildAnthropicTransport({ endpoint: opts.endpoint, model: opts.model, fetchImpl: opts.fetchImpl, enabled: opts.httpEnabled });
  return buildVendorProvider({ name: 'anthropic', transport, secretProvider: opts.secretProvider, credentialsRef: opts.credentialsRef, tenantId: opts.tenantId, confidenceThreshold: opts.confidenceThreshold });
}

module.exports = { buildAnthropicProvider, buildAnthropicTransport };
