'use strict';

/**
 * Production environment validation (Phase 61).
 * Runs before server startup when NODE_ENV=production.
 * Never logs secret values — only their names and structural problems.
 */

const KNOWN_PLACEHOLDERS = [
  'replace-me', 'changeme', 'change_me', 'your_secret', 'your-secret',
  'insert_secret', 'insert-secret', 'placeholder', 'example', 'todo',
  'fixme', 'put_your', 'put-your', 'enter_your', 'enter-your',
  'long-random-string',
];

function looksLikePlaceholder(val) {
  const lower = val.toLowerCase();
  return KNOWN_PLACEHOLDERS.some((p) => lower.includes(p));
}

function looksLikeLocalhost(urlStr) {
  if (!urlStr) return false;
  try {
    const { hostname } = new URL(urlStr);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch (_) {
    return false;
  }
}

/**
 * Validate the environment for production deployment.
 * @param {object} env - the frozen config object from env.js
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateProductionEnv(env) {
  const errors = [];
  const warnings = [];

  // DATABASE_URL — required everywhere; skip deep check here (done in env.js)
  if (!env.DATABASE_URL) errors.push('DATABASE_URL is required');

  // JWT_SECRET — reject placeholder and require production-grade length
  if (!env.JWT_SECRET) {
    errors.push('JWT_SECRET is required');
  } else {
    if (looksLikePlaceholder(env.JWT_SECRET)) {
      errors.push('JWT_SECRET appears to be a placeholder — set a cryptographically random secret');
    }
    if (env.JWT_SECRET.length < 64) {
      warnings.push('JWT_SECRET should be at least 64 characters for production (current: ' + env.JWT_SECRET.length + ')');
    }
  }

  // APP_BASE_URL — must not be localhost (breaks email deep-links)
  if (looksLikeLocalhost(env.APP_BASE_URL)) {
    errors.push('APP_BASE_URL must not reference localhost in production — email links will point to the developer machine');
  }

  // Payment provider must not be mock
  if (!env.PAYMENT_PROVIDER || env.PAYMENT_PROVIDER === 'mock') {
    errors.push('PAYMENT_PROVIDER=mock cannot be used in production — set a real payment provider (e.g. stripe)');
  }

  // Notification encryption key: required when email transport is configured
  const emailEnabled = (env.SMTP_HOST && env.SMTP_HOST.trim()) || (env.RESEND_API_KEY && env.RESEND_API_KEY.trim());
  if (emailEnabled && !env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY) {
    errors.push('QYRVIA_NOTIFICATION_ENCRYPTION_KEY is required when SMTP_HOST or RESEND_API_KEY is set in production');
  }
  if (env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY) {
    const keyLen = env.QYRVIA_NOTIFICATION_ENCRYPTION_KEY.trim().length;
    if (keyLen !== 44 && keyLen !== 64) {
      errors.push(
        'QYRVIA_NOTIFICATION_ENCRYPTION_KEY must be a base64-encoded 32-byte AES key (44 chars) or 64-char hex — got ' + keyLen + ' chars'
      );
    }
  }

  // OTA credential key: warn if OTA activations are configured without an encryption key
  if (env.CHANNEL_OTA_ACTIVATIONS && env.CHANNEL_OTA_ACTIVATIONS.trim()) {
    if (!env.CHANNEL_CREDENTIAL_KEY || !env.CHANNEL_CREDENTIAL_KEY.trim()) {
      warnings.push('CHANNEL_OTA_ACTIVATIONS is set but CHANNEL_CREDENTIAL_KEY is empty — OTA credentials will be stored unencrypted');
    }
  }

  // CORS_ORIGIN warning if not set (informational — same-origin may be intentional)
  if (!env.CORS_ORIGIN) {
    warnings.push('CORS_ORIGIN is not set — cross-origin browser requests will be blocked. Set to the SPA origin if served from a different domain');
  }

  return { errors, warnings };
}

/**
 * Phase 63 P1-3 — close the "NODE_ENV was never set" hole.
 *
 * `validateProductionEnv` only runs when NODE_ENV === 'production', and
 * NODE_ENV defaults to 'development'. A deployment that simply forgets to set
 * NODE_ENV therefore boots with PAYMENT_PROVIDER=mock, APP_BASE_URL pointing at
 * localhost, a 32-character JWT secret and no encryption-key check — silently,
 * with no signal anywhere that the production gate was skipped.
 *
 * The one unambiguous, non-heuristic signal that a process is NOT a local
 * development boot is a NON-LOCAL DATABASE_URL. Nobody points a laptop at a
 * remote multi-tenant database by accident and expects development defaults.
 *
 * So: unvalidated boot + remote database = refuse. Local development, CI and
 * the DB test runner (all loopback) are completely unaffected. The escape hatch
 * is explicit and must be typed deliberately.
 *
 * @param {object} env       frozen config
 * @param {object} processEnv raw process.env (to see whether NODE_ENV was set at all)
 * @returns {{ block: boolean, reason: string|null, warnings: string[] }}
 */
function checkUnvalidatedRemoteBoot(env, processEnv = process.env) {
  const warnings = [];

  if (env.NODE_ENV === 'production') {
    return { block: false, reason: null, warnings };
  }

  const nodeEnvWasExplicit = typeof processEnv.NODE_ENV === 'string' && processEnv.NODE_ENV.trim() !== '';
  if (!nodeEnvWasExplicit) {
    warnings.push(
      'NODE_ENV is not set — defaulting to "development". The production environment ' +
      'validation gate is NOT active for this boot.'
    );
  }

  const dbIsLocal = looksLikeLocalhost(env.DATABASE_URL);
  if (dbIsLocal) return { block: false, reason: null, warnings };

  const override = String(processEnv.QYRVIA_ALLOW_UNVALIDATED_REMOTE_DB || '').toLowerCase() === 'true';
  if (override) {
    warnings.push(
      'QYRVIA_ALLOW_UNVALIDATED_REMOTE_DB=true — booting against a NON-LOCAL database ' +
      'with NODE_ENV=' + env.NODE_ENV + ' and no production validation. This is unsafe outside a deliberate test.'
    );
    return { block: false, reason: null, warnings };
  }

  return {
    block: true,
    warnings,
    reason:
      'NODE_ENV is "' + env.NODE_ENV + '" (not "production") but DATABASE_URL points at a NON-LOCAL host, ' +
      'so the production environment validation gate was skipped for a deployment-like boot. ' +
      'Set NODE_ENV=production, or set QYRVIA_ALLOW_UNVALIDATED_REMOTE_DB=true if this is deliberate.'
  };
}

module.exports = { validateProductionEnv, looksLikePlaceholder, looksLikeLocalhost, checkUnvalidatedRemoteBoot };
