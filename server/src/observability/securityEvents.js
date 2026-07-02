'use strict';

/**
 * Security event logging (Phase 32). A fixed taxonomy of security-relevant
 * events emitted as structured log lines, always carrying the correlation
 * context (correlation/request/tenant/property/user/session) and a severity.
 * Never logs secrets (the base logger also redacts password/secret/token).
 */

const { logFields } = require('./correlation');

const CATEGORY = Object.freeze({ AUTH: 'auth', AUTHZ: 'authz', DB: 'db', API: 'api', INFRA: 'infra' });

// event -> { category, severity }
const EVENTS = Object.freeze({
  // Authentication
  'auth.login.success':       { category: CATEGORY.AUTH, severity: 'info' },
  'auth.login.failure':       { category: CATEGORY.AUTH, severity: 'warn' },
  'auth.logout':              { category: CATEGORY.AUTH, severity: 'info' },
  'auth.password.change':     { category: CATEGORY.AUTH, severity: 'notice' },
  'auth.password.reset':      { category: CATEGORY.AUTH, severity: 'notice' },
  'auth.mfa':                 { category: CATEGORY.AUTH, severity: 'info' },
  // Authorization
  'authz.permission_denied':  { category: CATEGORY.AUTHZ, severity: 'warn' },
  'authz.property_denied':    { category: CATEGORY.AUTHZ, severity: 'warn' },
  'authz.tenant_denied':      { category: CATEGORY.AUTHZ, severity: 'warn' },
  'authz.role_change':        { category: CATEGORY.AUTHZ, severity: 'notice' },
  'authz.privilege_escalation': { category: CATEGORY.AUTHZ, severity: 'critical' },
  // Database / RLS
  'db.rls_violation':         { category: CATEGORY.DB, severity: 'critical' },
  'db.missing_tenant_context':{ category: CATEGORY.DB, severity: 'error' },
  'db.missing_property_context': { category: CATEGORY.DB, severity: 'error' },
  // API
  'api.invalid_jwt':          { category: CATEGORY.API, severity: 'warn' },
  'api.expired_jwt':          { category: CATEGORY.API, severity: 'info' },
  'api.malformed_payload':    { category: CATEGORY.API, severity: 'warn' },
  'api.validation_failure':   { category: CATEGORY.API, severity: 'info' },
  // Infrastructure
  'infra.migration':          { category: CATEGORY.INFRA, severity: 'notice' },
  'infra.startup':            { category: CATEGORY.INFRA, severity: 'info' },
  'infra.shutdown':           { category: CATEGORY.INFRA, severity: 'info' },
  'infra.config_change':      { category: CATEGORY.INFRA, severity: 'notice' }
});

// map a custom severity onto a pino level
const LEVEL = { info: 'info', notice: 'info', warn: 'warn', error: 'error', critical: 'error' };

function buildSecurityEvents({ logger, metrics } = {}) {
  if (!logger) throw new Error('securityEvents: logger required');

  function emit(event, fields = {}) {
    const def = EVENTS[event] || { category: 'unknown', severity: 'warn' };
    const record = Object.assign(
      { evt: event, security: true, category: def.category, severity: def.severity },
      logFields(), fields
    );
    logger[LEVEL[def.severity] || 'warn'](record, event);
    if (metrics && typeof metrics.increment === 'function') {
      metrics.increment('security_events_total', 1, { event, category: def.category });
    }
    return record;
  }

  return { CATEGORY, EVENTS, emit };
}

module.exports = { buildSecurityEvents, EVENTS, CATEGORY };
