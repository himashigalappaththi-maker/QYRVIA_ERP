'use strict';

/**
 * MockProvider (Phase 27.1A) - the deterministic rule-based provider, aliased into
 * the multi-provider namespace. It is the GUARANTEED final fallback of the failover
 * chain (never throws, no network). Same implementation as Phase 27's MockAIProvider.
 */

const { MockAIProvider } = require('../provider/mockProvider');

class MockProvider extends MockAIProvider {}

module.exports = { MockProvider };
