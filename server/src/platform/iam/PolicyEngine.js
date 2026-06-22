'use strict';

/**
 * PolicyEngine (Phase 18) - evaluates role + permission + property context into
 * an ALLOW/DENY decision with a reason. Deny-by-default; enforces property
 * isolation (the principal must have access to the target property).
 */

function buildPolicyEngine({ rbac } = {}) {
  if (!rbac) throw new Error('PolicyEngine: rbac required');

  /**
   * @param principal { roles[], properties[] (accessible property ids) }
   * @param request   { permission, propertyId, now?, timeRestrictions? }
   */
  function evaluate(principal = {}, request = {}) {
    const roles = principal.roles || [];
    if (roles.length === 0) return { decision: 'DENY', reason: 'no_roles' };

    if (!rbac.hasPermission(roles, request.permission)) {
      return { decision: 'DENY', reason: 'permission_denied:' + request.permission };
    }

    // Property isolation: a property-scoped request requires access to it,
    // unless the principal is platform-wide (ADMIN or '*' in properties).
    if (request.propertyId) {
      const props = principal.properties || [];
      const wide = roles.includes('ADMIN') || props.includes('*');
      if (!wide && !props.includes(request.propertyId)) {
        return { decision: 'DENY', reason: 'property_isolation:' + request.propertyId };
      }
    }

    // Optional time-based restriction (future extension; honored if supplied).
    if (request.timeRestrictions && request.now != null) {
      const { startHourUTC, endHourUTC } = request.timeRestrictions;
      if (startHourUTC != null && endHourUTC != null) {
        const hour = new Date(request.now).getUTCHours();
        if (hour < startHourUTC || hour >= endHourUTC) return { decision: 'DENY', reason: 'time_restricted' };
      }
    }

    return { decision: 'ALLOW', reason: 'ok' };
  }

  return { evaluate };
}

module.exports = { buildPolicyEngine };
