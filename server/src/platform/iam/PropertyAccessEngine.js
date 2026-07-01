'use strict';

/**
 * PropertyAccessEngine (Phase 31.5) - role-driven, deterministic resolution of
 * which PROPERTIES a principal may act on, and with which capabilities. Builds
 * on the validated Phase 18 IAM (RBAC permissions, PolicyEngine isolation) and
 * the existing data model `user_roles(user_id, role_id, tenant_id, property_id)`
 * where property_id = a specific property and property_id IS NULL = tenant-wide.
 *
 * RLS stays at the Company (tenant) level (Phase 29-31). Property isolation is
 * APPLICATION-level and is computed here from role assignments - it never
 * replaces or weakens tenant RLS.
 *
 * The 7 enterprise archetypes (every rule is role-driven):
 *   COMPANY_ADMIN         - all properties of the company
 *   PROPERTY_ADMIN        - only its assigned property
 *   DEPARTMENT_HEAD       - configurable set of assigned properties
 *   STAFF                 - only its assigned property
 *   CORPORATE_FINANCE     - all properties, READ-ONLY consolidated visibility
 *   CORPORATE_PROCUREMENT - all properties, cross-property purchasing (write)
 *   REGIONAL_MANAGER      - configurable property GROUPS
 */

const PROPERTY_ROLE_SCOPES = Object.freeze({
  COMPANY_ADMIN:         { scope: 'ALL',          write: true,  consolidated: true,  crossProperty: true },
  PROPERTY_ADMIN:        { scope: 'ASSIGNED',     write: true,  consolidated: false, crossProperty: false },
  DEPARTMENT_HEAD:       { scope: 'ASSIGNED_SET', write: true,  consolidated: false, crossProperty: false },
  STAFF:                 { scope: 'ASSIGNED',     write: false, consolidated: false, crossProperty: false },
  CORPORATE_FINANCE:     { scope: 'ALL',          write: false, consolidated: true,  crossProperty: false },
  CORPORATE_PROCUREMENT: { scope: 'ALL',          write: true,  consolidated: true,  crossProperty: true },
  REGIONAL_MANAGER:      { scope: 'GROUP',        write: true,  consolidated: true,  crossProperty: true }
});

function buildPropertyAccessEngine({ roleScopes } = {}) {
  const SCOPES = roleScopes || PROPERTY_ROLE_SCOPES;

  function scopeFor(role) { return SCOPES[role] || null; }

  /**
   * Resolve a principal's effective property access.
   * @param principal { assignments: [{ role, propertyId?, groupId? }] }
   * @param world     { allProperties: string[], groups?: { [groupId]: string[] } }
   * @returns { accessible:Set, writable:Set, consolidated:bool, crossProperty:bool, roles:string[] }
   */
  function resolve(principal = {}, world = {}) {
    const all = world.allProperties || [];
    const groups = world.groups || {};
    const assignments = principal.assignments || [];

    const accessible = new Set();
    const writable = new Set();
    let consolidated = false, crossProperty = false;
    const roles = [];

    for (const a of assignments) {
      const s = scopeFor(a.role);
      if (!s) continue;                 // unknown role => grants nothing (deny by default)
      roles.push(a.role);
      consolidated = consolidated || s.consolidated;
      crossProperty = crossProperty || s.crossProperty;

      let set = [];
      if (s.scope === 'ALL') set = all;
      else if (s.scope === 'GROUP') set = groups[a.groupId] || [];
      else {
        // ASSIGNED / ASSIGNED_SET: a specific property, or tenant-wide when NULL
        // (mirrors user_roles.property_id IS NULL => company-wide grant).
        set = a.propertyId == null ? all : [a.propertyId];
      }
      for (const p of set) { accessible.add(p); if (s.write) writable.add(p); }
    }
    return { accessible, writable, consolidated, crossProperty, roles };
  }

  /** Array of accessible property ids - the shape PolicyEngine expects in principal.properties. */
  function accessiblePropertyIds(principal, world) {
    return Array.from(resolve(principal, world).accessible);
  }

  function canAccess(principal, world, propertyId) {
    return resolve(principal, world).accessible.has(propertyId);
  }
  function canWrite(principal, world, propertyId) {
    return resolve(principal, world).writable.has(propertyId);
  }
  function canConsolidate(principal, world) { return resolve(principal, world).consolidated; }
  function canCrossPropertyPurchase(principal, world) {
    const r = resolve(principal, world);
    return r.crossProperty && r.roles.some((x) => x === 'CORPORATE_PROCUREMENT' || x === 'COMPANY_ADMIN');
  }

  return {
    SCOPES, scopeFor, resolve, accessiblePropertyIds,
    canAccess, canWrite, canConsolidate, canCrossPropertyPurchase
  };
}

module.exports = { buildPropertyAccessEngine, PROPERTY_ROLE_SCOPES };
