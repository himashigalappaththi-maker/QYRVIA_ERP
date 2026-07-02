'use strict';

/**
 * ProviderFailoverChain (Phase 27.1A) - tries providers in order; a provider that
 * throws (ProviderUnavailable) or returns nothing is skipped and the next is tried.
 * The Mock provider is appended as the GUARANTEED final fallback (never throws,
 * no network), so a result is always produced. Booking-critical replies are
 * rendered deterministically by Mock regardless of provider (no hallucination).
 *
 * The agent is unchanged: the chain IS an AIProvider.
 */

const { MockProvider } = require('./MockProvider');

const CRITICAL_ACTIONS = new Set(['created', 'updated', 'cancelled', 'collect', 'need_reference', 'rejected']);

function buildProviderFailoverChain(providers, { mock } = {}) {
  const fb = mock || new MockProvider();
  const chain = (providers || []).filter(Boolean).concat([fb]);

  async function run(method, args) {
    for (const p of chain) {
      try { const r = await p[method](...args); if (r != null) return r; }
      catch (_) { /* unavailable -> next provider */ }
    }
    return fb[method](...args); // safety net (mock never throws)
  }

  return {
    kind: 'failover',
    order: chain.map((p) => p.kind || p.name || 'mock'),
    classifyIntent: (t) => run('classifyIntent', [t]),
    extractEntities: (t) => run('extractEntities', [t]),
    generateResponse: (ctx) => (ctx && CRITICAL_ACTIONS.has(ctx.action)) ? fb.generateResponse(ctx) : run('generateResponse', [ctx])
  };
}

module.exports = { buildProviderFailoverChain };
