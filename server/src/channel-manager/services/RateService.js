'use strict';

/**
 * RateService - validates + normalizes rate inputs into CanonicalRate. The
 * layer exists so business rules (e.g., min/max guard rails) have a home that
 * is OTA-agnostic.
 */

const { makeCanonicalRate, rateKey } = require('../core/canonical/CanonicalRate');

function buildRateService() {
  return {
    validate(fields) {
      const rate = makeCanonicalRate(fields);
      return rate;
    },
    key: rateKey
  };
}

module.exports = { buildRateService };
