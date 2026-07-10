'use strict';

const { randomUUID } = require('crypto');

function buildMockPaymentProvider({ config = {} } = {}) {
  async function initiate({ amount, currency, bookingRef, guestEmail, metadata } = {}) {
    return {
      ok:           true,
      paymentId:    'mock_pay_' + randomUUID(),
      redirectUrl:  null,
      clientSecret: null,
      provider:     'mock',
    };
  }

  async function verify({ paymentId } = {}) {
    return {
      ok:       true,
      status:   'paid',
      amount:   null,
      currency: null,
      provider: 'mock',
    };
  }

  async function capture({ paymentId } = {}) {
    return {
      ok:             true,
      capturedAmount: null,
      provider:       'mock',
    };
  }

  async function refund({ paymentId, amount, reason } = {}) {
    return {
      ok:       true,
      refundId: 'mock_ref_' + randomUUID(),
      provider: 'mock',
    };
  }

  async function health() {
    return {
      ok:       true,
      provider: 'mock',
      mode:     'mock',
    };
  }

  return { initiate, verify, capture, refund, health };
}

module.exports = { buildMockPaymentProvider };
