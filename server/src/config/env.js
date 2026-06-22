'use strict';

/**
 * Env loader + validator. Fails fast at boot if a required key is missing.
 *
 * Exports a frozen object so downstream code cannot mutate config at runtime.
 */

require('dotenv').config();

const REQUIRED = ['DATABASE_URL', 'JWT_SECRET'];

function getOptional(name, fallback) {
  const v = process.env[name];
  return (v === undefined || v === '') ? fallback : v;
}

const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].trim() === '');
if (missing.length) {
  // eslint-disable-next-line no-console
  console.error('[env] missing required environment variables: ' + missing.join(', '));
  // eslint-disable-next-line no-console
  console.error('[env] copy .env.example to .env and fill in real values');
  process.exit(2);
}

// Sanity-check JWT_SECRET length to fail loud on a too-short value
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  // eslint-disable-next-line no-console
  console.error('[env] JWT_SECRET must be at least 32 characters');
  process.exit(2);
}

const config = Object.freeze({
  NODE_ENV:               getOptional('NODE_ENV', 'development'),
  PORT:                   parseInt(getOptional('PORT', '3001'), 10),
  LOG_LEVEL:              getOptional('LOG_LEVEL', 'info'),
  DATABASE_URL:           process.env.DATABASE_URL,
  JWT_SECRET:             process.env.JWT_SECRET,
  JWT_SECRET_PREV:        getOptional('JWT_SECRET_PREV', ''),
  ACCESS_TOKEN_TTL_SEC:   parseInt(getOptional('ACCESS_TOKEN_TTL_SEC', '900'), 10),
  REFRESH_TOKEN_TTL_DAYS: parseInt(getOptional('REFRESH_TOKEN_TTL_DAYS', '30'), 10),
  BCRYPT_ROUNDS:          parseInt(getOptional('BCRYPT_ROUNDS', '12'), 10)
});

module.exports = config;
