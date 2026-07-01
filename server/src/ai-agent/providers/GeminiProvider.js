'use strict';

/**
 * GeminiProvider (Phase 27.1A) - Gemini generateContent abstraction. Transport
 * DEFAULT DISABLED. Key via SecretProvider as the x-goog-api-key HEADER (not a URL
 * query, to avoid key-in-URL leakage), execution-time only. Hospitality default:
 * preferred for marketing content.
 */

const { buildVendorProvider } = require('./AIProvider');

function buildGeminiTransport({ endpoint, model = 'gemini-1.5-flash', fetchImpl, enabled = false } = {}) {
  return {
    kind: 'gemini-http', enabled, model, endpoint: endpoint || null,
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
          headers: Object.assign({ 'content-type': 'application/json' }, apiKey ? { 'x-goog-api-key': apiKey } : {}),
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text: user }] }] })
        });
        if (!res.ok) return { ok: false, error: 'http_' + res.status };
        const json = await res.json();
        const content = (json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text) || '';
        return { ok: true, content };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
  };
}

function buildGeminiProvider(opts = {}) {
  const transport = opts.transport || buildGeminiTransport({ endpoint: opts.endpoint, model: opts.model, fetchImpl: opts.fetchImpl, enabled: opts.httpEnabled });
  return buildVendorProvider({ name: 'gemini', transport, secretProvider: opts.secretProvider, credentialsRef: opts.credentialsRef, tenantId: opts.tenantId, confidenceThreshold: opts.confidenceThreshold });
}

module.exports = { buildGeminiProvider, buildGeminiTransport };
