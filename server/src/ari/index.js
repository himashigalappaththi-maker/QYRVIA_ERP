'use strict';

/**
 * ARI Foundation (Phase 30.1) - public entry point.
 *
 * A standalone, deterministic Availability / Rates / Restrictions engine. No OTA
 * integration, no UI, no coupling to the channel adapters or canonical registry.
 * Future phases consume `service.computeAri()` / `service.quoteStay()` and map the
 * neutral output contract to each OTA (see the Phase 30.1 report, Integration
 * Boundary). Default store is in-memory; inject the DB store for persistence.
 */

const { buildAriService } = require('./ariService');
const { buildMemoryAriStore } = require('./store/memoryStore');
const model = require('./model');
const availabilityEngine = require('./availabilityEngine');
const rateEngine = require('./rateEngine');
const restrictionEngine = require('./restrictionEngine');
const ruleResolver = require('./ruleResolver');
const outputContract = require('./outputContract');
const mapping = require('./mapping');

function buildAri({ store } = {}) {
  const s = store || buildMemoryAriStore();
  return { service: buildAriService({ store: s }), store: s };
}

module.exports = {
  buildAri,
  buildAriService,
  buildMemoryAriStore,
  model,
  availabilityEngine,
  rateEngine,
  restrictionEngine,
  ruleResolver,
  outputContract,
  mapping
};
