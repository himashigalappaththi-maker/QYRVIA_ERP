'use strict';

/**
 * AI provider factory (Phase 27 / 27.1) - selects the provider by config with NO
 * vendor lock-in and NO agent change:
 *   kind 'mock' (default) -> deterministic MockAIProvider
 *   kind 'llm' | 'http'   -> real LLM provider over an HTTP transport (default
 *                            DISABLED) with SecretProvider-resolved key + rule
 *                            fallback. Swapping is config only.
 */

const { AIProvider, MockAIProvider, renderReply } = require('./mockProvider');
const { buildLlmAiProvider } = require('./llmAiProvider');
const { buildHttpLlmTransport } = require('./llmTransport');

function buildAiProvider(opts = {}) {
  const kind = opts.kind || 'mock';
  if (kind === 'mock') return new MockAIProvider();
  if (kind === 'llm' || kind === 'http') {
    const transport = opts.transport || buildHttpLlmTransport({
      endpoint: opts.endpoint, model: opts.model, fetchImpl: opts.fetchImpl, enabled: opts.httpEnabled
    });
    return buildLlmAiProvider({
      transport, secretProvider: opts.secretProvider, credentialsRef: opts.credentialsRef,
      tenantId: opts.tenantId, confidenceThreshold: opts.confidenceThreshold, fallback: new MockAIProvider()
    });
  }
  throw new Error('ai_provider_not_available: ' + kind);
}

module.exports = {
  AIProvider, MockAIProvider, renderReply,
  buildAiProvider, buildLlmAiProvider, buildHttpLlmTransport
};
