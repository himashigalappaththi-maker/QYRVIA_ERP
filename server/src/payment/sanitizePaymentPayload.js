'use strict';

const SENSITIVE_KEYS = new Set([
  'clientSecret', 'client_secret',
  'cardNumber', 'card_number',
  'cvv', 'cvc',
  'apiKey', 'api_key', 'secretKey', 'secret_key',
  'privateKey', 'private_key',
  'authorization', 'Authorization',
  'stripeKey', 'stripe_key',
  'paymentToken', 'payment_token',
]);

function sanitizePaymentPayload(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : v;
  }
  return out;
}

module.exports = { sanitizePaymentPayload };
