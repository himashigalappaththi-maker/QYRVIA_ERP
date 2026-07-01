'use strict';

const env = require('../config/env');

/**
 * Phase 23 R2 — shared error-envelope builder.
 *
 * `buildError` is the normalized internal error object. `errorField` is what
 * actually goes in the response body's `error` slot, honoring the ERROR_ENVELOPE
 * feature flag:
 *   - 'string' (default, legacy):  error: "CODE"
 *   - 'object'                  :  error: { code, message }
 *
 * The frontend apiClient (Step 3, R2 Stage A) already accepts both shapes, so the
 * flag can be flipped without any frontend change. Default is legacy string, so
 * enabling this module changes no output until the flag is set.
 */

function buildError(code, message) {
  const c = String(code || 'internal_error');
  return { code: c, message: String(message || c) };
}

function errorField(code, message) {
  if (env.ERROR_ENVELOPE === 'object') return buildError(code, message);
  return String(code || 'internal_error');
}

module.exports = { buildError, errorField };
