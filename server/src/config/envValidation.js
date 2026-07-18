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

module.exports = { validateProductionEnv, looksLikePlaceholder, looksLikeLocalhost };
