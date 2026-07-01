'use strict';

/**
 * Unified OTA adapter framework (Phase 24 B8-A) - public entry point.
 *
 * `buildCanonicalAdapterRegistry()` returns the single canonical registry
 * pre-loaded with the LIVE mock adapters bridged into the unified contract.
 * No real OTA connectivity is wired here.
 */

const { CanonicalOTAAdapter, CANONICAL_METHODS } = require('./CanonicalOTAAdapter');
const { AuthStrategy, NoopAuthStrategy } = require('./AuthStrategy');
const validator = require('./adapterValidator');
const { buildAdapterRegistry } = require('./adapterRegistry');
const { bridgeLegacyAdapter } = require('./legacyBridge');

const { QTCNAdapter } = require('../qyrcn/QTCNAdapter');
const { BookingComAdapter } = require('../bookingcom/BookingComAdapter');
const { AgodaAdapter } = require('../agoda/AgodaAdapter');
const { ExpediaAdapter } = require('../expedia/ExpediaAdapter');
const { AirbnbAdapter } = require('../airbnb/AirbnbAdapter');

function buildCanonicalAdapterRegistry() {
  const reg = buildAdapterRegistry();
  reg.register(bridgeLegacyAdapter(new QTCNAdapter()));       // internal, first-class
  reg.register(bridgeLegacyAdapter(new BookingComAdapter())); // working mock
  reg.register(bridgeLegacyAdapter(new AgodaAdapter()));
  reg.register(bridgeLegacyAdapter(new ExpediaAdapter()));
  reg.register(bridgeLegacyAdapter(new AirbnbAdapter()));
  return reg;
}

module.exports = {
  CanonicalOTAAdapter, CANONICAL_METHODS,
  AuthStrategy, NoopAuthStrategy,
  validator,
  buildAdapterRegistry,
  bridgeLegacyAdapter,
  buildCanonicalAdapterRegistry
};
