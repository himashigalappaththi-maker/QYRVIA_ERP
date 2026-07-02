'use strict';

/**
 * OpenAIProvider (Phase 27.1A) - Chat Completions abstraction. Transport DEFAULT
 * DISABLED. Key via SecretProvider (Authorization: Bearer, execution-time only).
 * Hospitality default: preferred for forecasting + analytics.
 */

const { buildVendorProvider } = require('./AIProvider');

function buildOpenAITransport({ endpoint, model = 'gpt-4o-mini', fetchImpl, enabled = false } = {}) {
  return {
    kind: 'openai-http', enabled, model, endpoint: endpoint || null,
    async chat(messages, { apiKey } = {}) {
      if (!enabled) return { ok: false, error: 'disabled' };
      if (!endpoint) return { ok: false, error: 'endpoint_required' };
      const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) return { ok: false, error: 'no_fetch' };
      try {
        const res = await f(endpoint, {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
          body: JSON.stringify({ model, messages })
        });
        if (!res.ok) return { ok: false, error: 'http_' + res.status };
        const json = await res.json();
        const content = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || (json && json.content) || '';
        return { ok: true, content };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
  };
}

function buildOpenAIProvider(opts = {}) {
  const transport = opts.transport || buildOpenAITransport({ endpoint: opts.endpoint, model: opts.model, fetchImpl: opts.fetchImpl, enabled: opts.httpEnabled });
  return buildVendorProvider({ name: 'openai', transport, secretProvider: opts.secretProvider, credentialsRef: opts.credentialsRef, tenantId: opts.tenantId, confidenceThreshold: opts.confidenceThreshold });
}

module.exports = { buildOpenAIProvider, buildOpenAITransport };
