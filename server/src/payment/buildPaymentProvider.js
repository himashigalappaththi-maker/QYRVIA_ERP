'use strict';

const { buildMockPaymentProvider } = require('./mockPaymentProvider');

function buildPaymentProvider({ config = {} } = {}) {
  const providerName = (config.provider || process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

  if (providerName === 'mock' || !providerName) {
    return buildMockPaymentProvider({ config });
  }

  // Future: 'stripe', 'payhere', etc.
  throw new Error(`payment_provider_not_configured: ${providerName}`);
}

module.exports = { buildPaymentProvider };
