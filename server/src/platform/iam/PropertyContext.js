'use strict';

/**
 * PropertyContext (Phase 31.5) - the per-request/per-job property context and
 * the mandatory audit envelope. Contexts are IMMUTABLE (frozen) and switching
 * returns a NEW context rather than mutating in place, so a context can never
 * leak across requests, pooled connections, or scheduled-job runs (there is no
 * shared mutable state to inherit). RLS tenant scoping is unaffected; this is
 * the application-level property layer.
 */

const crypto = require('crypto');
const { getObservability } = require('../../observability');

// Phase 33: record a property-scope RLS gap without ever blocking the caller.
function recordPropertyGap() {
  try { getObservability().rls.missingContext('property'); } catch (_) { /* telemetry only */ }
}
function recordPropertyDenied() {
  try { getObservability().rls.denied({ scope: 'property' }); } catch (_) { /* telemetry only */ }
}

/** Build an immutable context. tenantId + userId are mandatory; propertyId optional (company-scope). */
function buildContext({ tenantId, userId, propertyId = null, requestId, sessionId = null } = {}) {
  if (!tenantId) throw new Error('PropertyContext: tenantId is required');
  if (!userId) throw new Error('PropertyContext: userId is required');
  return Object.freeze({
    tenantId,
    userId,
    propertyId: propertyId || null,
    requestId: requestId || crypto.randomUUID(),
    sessionId
  });
}

/**
 * Switch the active property. Returns a NEW frozen context (the old one is never
 * mutated). The caller MUST pass the set of accessible property ids; switching to
 * an unassigned property throws - the switch cannot silently succeed.
 */
function switchProperty(ctx, targetPropertyId, accessiblePropertyIds = []) {
  if (!ctx || !ctx.tenantId) throw new Error('switchProperty: invalid context');
  if (!accessiblePropertyIds.includes(targetPropertyId)) {
    recordPropertyDenied();
    const e = new Error('property_access_denied:' + targetPropertyId);
    e.code = 'PROPERTY_ACCESS_DENIED';
    throw e;
  }
  // fresh context, fresh requestId => no cached/stale data can ride along
  return buildContext({
    tenantId: ctx.tenantId, userId: ctx.userId, propertyId: targetPropertyId, sessionId: ctx.sessionId
  });
}

/**
 * The audit envelope every transaction must carry. Tenant ID, Property ID, User
 * ID and Timestamp are mandatory - throws if any is missing. Background/scheduled
 * jobs must build this from an EXPLICIT context (no implicit/inherited property).
 */
function auditEnvelope(ctx, { action, occurredAt } = {}) {
  if (!ctx || !ctx.tenantId) throw new Error('auditEnvelope: tenantId required');
  if (!ctx.userId) throw new Error('auditEnvelope: userId required');
  if (!ctx.propertyId) { recordPropertyGap(); throw new Error('auditEnvelope: propertyId required (explicit property context)'); }
  return Object.freeze({
    tenant_id: ctx.tenantId,
    property_id: ctx.propertyId,
    user_id: ctx.userId,
    occurred_at: occurredAt || new Date().toISOString(),
    request_id: ctx.requestId,
    action: action || null
  });
}

/**
 * Build a context for a background/scheduled job. propertyId is REQUIRED here -
 * a job may never inherit a previous run's property; it must be told explicitly.
 */
function jobContext({ tenantId, propertyId, jobName } = {}) {
  if (!propertyId) { recordPropertyGap(); throw new Error('jobContext: explicit propertyId is required (no inheritance)'); }
  return buildContext({ tenantId, userId: 'system:' + (jobName || 'job'), propertyId });
}

module.exports = { buildContext, switchProperty, auditEnvelope, jobContext };
