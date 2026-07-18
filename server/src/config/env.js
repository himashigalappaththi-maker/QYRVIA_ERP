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
  BCRYPT_ROUNDS:          parseInt(getOptional('BCRYPT_ROUNDS', '12'), 10),
  // Phase 23 R2: error envelope shape. 'string' (default, legacy) emits error:"CODE";
  // 'object' emits error:{ code, message }. Frontend apiClient already accepts both.
  ERROR_ENVELOPE:         getOptional('ERROR_ENVELOPE', 'string'),
  // Phase 32: DB observability. Default ON - wraps the pg pool so queries emit
  // low-cardinality metrics + slow-query detection (SQL hash only, never the SQL
  // text/params). Set 'false' to bypass the instrumented pool wrapper entirely.
  DB_OBSERVABILITY:       getOptional('DB_OBSERVABILITY', 'true'),
  // Phase 24 S4/B3: channel persistence mode. 'memory' (default) = in-memory stores
  // (current behavior); 'dual' = mirror writes to DB; 'db' = DB-authoritative.
  CHANNEL_PERSISTENCE:    getOptional('CHANNEL_PERSISTENCE', 'memory'),
  // Phase 24 B6: durable queue worker. Default OFF; worker starts only when 'true'.
  CHANNEL_WORKER_ENABLED: getOptional('CHANNEL_WORKER_ENABLED', 'false'),
  // Phase 24 B8-B1: encryption key for the local SecretProvider (32-byte: 64-hex,
  // base64-32, or passphrase). Empty default => no provider (credential subsystem dormant).
  CHANNEL_CREDENTIAL_KEY: getOptional('CHANNEL_CREDENTIAL_KEY', ''),
  // Phase 24 B8-B3: channels enabled for REAL outbound sync (CSV). Default QYRVIA_CONNECT
  // (in-process, QYRVIA-owned B2B OTA/distribution platform). Third-party OTAs stay mock until B8-B5.
  CHANNEL_REALSYNC_CHANNELS: getOptional('CHANNEL_REALSYNC_CHANNELS', 'QYRVIA_CONNECT'),
  // Phase 24 B8-B4: inbound webhook ingress route. Default OFF; mounted only when 'true'.
  CHANNEL_WEBHOOK_ENABLED: getOptional('CHANNEL_WEBHOOK_ENABLED', 'false'),
  // Phase 24 B8-B5: master switch for real third-party HTTP transport. Default OFF =>
  // no external OTA network call. CHANNEL_OTA_ACTIVATIONS is a JSON map of per-channel
  // { enabled, http, endpoint, credentials_ref, tenant_id }; empty default => none active.
  CHANNEL_HTTP_ENABLED: getOptional('CHANNEL_HTTP_ENABLED', 'false'),
  CHANNEL_OTA_ACTIVATIONS: getOptional('CHANNEL_OTA_ACTIVATIONS', ''),
  // Phase 28: ChannelManagerCore is backed by the canonical adapter registry
  // (adapters/framework/*). Default 'true' = canonical registry is the single source
  // of truth; legacy adapters are auto-bridged into the canonical contract, behavior
  // preserved. Rollback: set 'false' to restore the pre-migration legacy Map registry
  // (the legacy code path is retained, not removed).
  CHANNEL_CANONICAL_CORE: getOptional('CHANNEL_CANONICAL_CORE', 'true'),
  // Phase 27 / 27.1A: AI WhatsApp Booking Agent. Default OFF. Multi-provider chain:
  // primary -> fallback -> tertiary -> mock. Default primary 'anthropic'; runtime stays
  // OFF unless the agent is enabled AND vendor HTTP is enabled with keys/endpoints.
  AI_AGENT_ENABLED:       getOptional('AI_AGENT_ENABLED', 'false'),
  AI_PROVIDER:            getOptional('AI_PROVIDER', 'anthropic'),
  AI_FALLBACK_PROVIDER:   getOptional('AI_FALLBACK_PROVIDER', 'openai'),
  AI_TERTIARY_PROVIDER:   getOptional('AI_TERTIARY_PROVIDER', 'gemini'),
  // Phase 27.1: real LLM provider. Default OFF (no external call). When AI_PROVIDER='llm',
  // AI_LLM_ENABLED + endpoint + credentials_ref are required to actually contact a vendor.
  AI_LLM_ENABLED:         getOptional('AI_LLM_ENABLED', 'false'),
  AI_LLM_ENDPOINT:        getOptional('AI_LLM_ENDPOINT', ''),
  AI_LLM_MODEL:           getOptional('AI_LLM_MODEL', 'gpt-4o-mini'),
  AI_LLM_CREDENTIALS_REF: getOptional('AI_LLM_CREDENTIALS_REF', ''),
  // Phase 27.3 - AI Booking Confirmation. Default OFF: no outbound confirmation is
  // built or enqueued and the booking engine runs with no onEvent (zero overhead,
  // zero behavior change). When enabled, post-booking events are templated
  // (deterministic, system-rendered references - never LLM), then auto-sent or
  // escalated per the decision tree and delivered via a MOCK transport (no external
  // calls). AUTO_SEND='false' forces every confirmation to escalate (manual approval).
  // MIN_CONFIDENCE escalates anything below the threshold. Rollback: set ENABLED='false'.
  AI_CONFIRMATION_ENABLED:        getOptional('AI_CONFIRMATION_ENABLED', 'false'),
  AI_CONFIRMATION_AUTO_SEND:      getOptional('AI_CONFIRMATION_AUTO_SEND', 'true'),
  AI_CONFIRMATION_MIN_CONFIDENCE: getOptional('AI_CONFIRMATION_MIN_CONFIDENCE', '0.5'),
  AI_CONFIRMATION_TRANSPORT:      getOptional('AI_CONFIRMATION_TRANSPORT', 'mock'),
  // Phase 53 Fix 1: webhook signature enforcement. Default 'true' (safe for live OTA).
  // Set CHANNEL_WEBHOOK_REQUIRE_SIGNATURE=false to skip signature checks in dev/test.
  CHANNEL_WEBHOOK_REQUIRE_SIGNATURE: getOptional('CHANNEL_WEBHOOK_REQUIRE_SIGNATURE', 'true'),
  // Phase 54: two-phase booking payment.
  // PAYMENT_HOLD_TTL_SECONDS: how long (in seconds) a payment hold remains valid. Default 900 (15 min).
  // PAYMENT_PROVIDER: which payment provider to use. Default 'mock'.
  PAYMENT_HOLD_TTL_SECONDS: getOptional('PAYMENT_HOLD_TTL_SECONDS', '900'),
  PAYMENT_PROVIDER:         getOptional('PAYMENT_PROVIDER',          'mock'),
  // Phase 58: transactional email delivery. SMTP and Resend are mutually exclusive;
  // SMTP takes precedence when SMTP_HOST is set. Leave all empty to disable email
  // (invitations and password resets still work — tokens are returned in API responses
  // for CLI/admin use; the email send just becomes a no-op).
  // APP_BASE_URL is the public SPA base URL embedded in email deep-links.
  // QYRVIA_NOTIFICATION_ENCRYPTION_KEY: base64-encoded 32-byte AES-256-GCM key.
  // Missing or wrong-length key fails closed in production.
  QYRVIA_NOTIFICATION_ENCRYPTION_KEY: getOptional('QYRVIA_NOTIFICATION_ENCRYPTION_KEY', ''),
  SMTP_HOST:      getOptional('SMTP_HOST',      ''),
  SMTP_PORT:      parseInt(getOptional('SMTP_PORT', '587'), 10),
  SMTP_SECURE:    getOptional('SMTP_SECURE',    'false'),
  SMTP_USER:      getOptional('SMTP_USER',      ''),
  SMTP_PASS:      getOptional('SMTP_PASS',      ''),
  SMTP_FROM:      getOptional('SMTP_FROM',      ''),
  RESEND_API_KEY: getOptional('RESEND_API_KEY', ''),
  RESEND_FROM:    getOptional('RESEND_FROM',    ''),
  APP_BASE_URL:   getOptional('APP_BASE_URL',   'http://localhost:3001'),
  // Phase 61: CORS and proxy hardening.
  // CORS_ORIGIN: allowed cross-origin for the SPA (e.g. https://app.qyrvia.com).
  // Empty (default) = same-origin only; no Access-Control-Allow-Origin header emitted.
  CORS_ORIGIN:    getOptional('CORS_ORIGIN',    ''),
  // TRUST_PROXY: passed directly to Express app.set('trust proxy', ...).
  // '1' (default) = trust exactly one reverse-proxy hop (nginx/load-balancer in front).
  // 'false' = no proxy. 'loopback' = loopback only. Numeric string parsed to number.
  TRUST_PROXY:    getOptional('TRUST_PROXY',    '1'),
});

// Phase 61: production environment validation gate.
// Only runs when NODE_ENV=production to avoid breaking dev/test boots.
if (config.NODE_ENV === 'production') {
  const { validateProductionEnv } = require('./envValidation');
  const { errors, warnings } = validateProductionEnv(config);
  for (const w of warnings) {
    // eslint-disable-next-line no-console
    console.warn('[env:prod] WARNING: ' + w);
  }
  if (errors.length) {
    for (const e of errors) {
      // eslint-disable-next-line no-console
      console.error('[env:prod] ERROR: ' + e);
    }
    // eslint-disable-next-line no-console
    console.error('[env:prod] ' + errors.length + ' production environment error(s) — refusing to start');
    process.exit(2);
  }
}

module.exports = config;
