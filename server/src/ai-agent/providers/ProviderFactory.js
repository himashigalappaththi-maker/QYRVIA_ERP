'use strict';

/**
 * ProviderFactory (Phase 27.1A) - builds providers by kind (mock | anthropic |
 * openai | gemini) and assembles the agent's failover chain
 * (primary -> fallback -> tertiary -> mock) from config. NO generic 'llm' kind.
 * Also exposes the hospitality routing policy (task -> preferred provider).
 */

const env = require('../../config/env');
const { MockProvider } = require('./MockProvider');
const { buildAnthropicProvider } = require('./AnthropicProvider');
const { buildOpenAIProvider } = require('./OpenAIProvider');
const { buildGeminiProvider } = require('./GeminiProvider');
const { buildProviderFailoverChain } = require('./ProviderFailoverChain');

const KINDS = Object.freeze(['mock', 'anthropic', 'openai', 'gemini']);

// Hospitality routing policy: task -> preferred provider (used by future task-
// specific callers; the guest agent uses the primary->fallback->tertiary chain).
const ROUTING_POLICY = Object.freeze({
  guest_conversation:     'anthropic',
  reservation_extraction: 'anthropic',
  forecasting:            'openai',
  marketing_content:      'gemini',
  analytics:              'openai',
  ai_copilot:             'anthropic'
});
function preferredProviderForTask(task) { return ROUTING_POLICY[task] || 'anthropic'; }

function buildProvider(kind, opts = {}) {
  switch (kind) {
    case 'mock':      return new MockProvider();
    case 'anthropic': return buildAnthropicProvider(opts);
    case 'openai':    return buildOpenAIProvider(opts);
    case 'gemini':    return buildGeminiProvider(opts);
    default:          throw new Error('unknown_ai_provider: ' + kind);
  }
}

/** The agent's provider: a failover chain primary -> fallback -> tertiary -> mock. */
function buildAgentProvider(opts = {}) {
  const primary  = opts.primary  || env.AI_PROVIDER          || 'anthropic';
  const fallback = opts.fallback || env.AI_FALLBACK_PROVIDER || 'openai';
  const tertiary = opts.tertiary || env.AI_TERTIARY_PROVIDER || 'gemini';

  const order = [];
  for (const k of [primary, fallback, tertiary]) {
    if (k && k !== 'mock' && KINDS.includes(k) && !order.includes(k)) order.push(k);
  }
  const providers = order.map((k) => buildProvider(k, opts)); // vendor transports default DISABLED
  return buildProviderFailoverChain(providers, { mock: new MockProvider() });
}

function validateConfig(cfg = {}) {
  const invalid = ['primary', 'fallback', 'tertiary'].map((k) => cfg[k]).filter((v) => v && !KINDS.includes(v));
  return { ok: invalid.length === 0, invalid };
}

module.exports = { buildProvider, buildAgentProvider, ROUTING_POLICY, preferredProviderForTask, validateConfig, KINDS };
