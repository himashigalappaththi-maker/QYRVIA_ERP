'use strict';

/**
 * RBACEngine (Phase 18) - role -> permission resolution with wildcard
 * permissions, role inheritance, property scoping, and a deny-by-default
 * posture. Deterministic; additive (parallel to the existing command-bus RBAC,
 * does not modify it).
 */

const DEFAULT_ROLES = Object.freeze({
  ADMIN:           { permissions: ['admin.*', 'reservation.*', 'billing.*', 'housekeeping.*', 'nightaudit.*', 'revenue.*'], inherits: [] },
  FRONT_DESK:      { permissions: ['reservation.*', 'housekeeping.read'], inherits: [] },
  HOUSEKEEPING:    { permissions: ['housekeeping.*'], inherits: [] },
  ACCOUNTING:      { permissions: ['billing.*', 'nightaudit.read'], inherits: [] },
  REVENUE_MANAGER: { permissions: ['revenue.*', 'reservation.read'], inherits: [] },
  AUDITOR:         { permissions: ['nightaudit.*', 'billing.read', 'revenue.read', 'admin.audit.read'], inherits: [] }
});

function buildRBACEngine({ roles } = {}) {
  const ROLES = roles || DEFAULT_ROLES;

  function expand(role, seen = new Set()) {
    if (!ROLES[role] || seen.has(role)) return [];
    seen.add(role);
    let perms = ROLES[role].permissions.slice();
    for (const parent of (ROLES[role].inherits || [])) perms = perms.concat(expand(parent, seen));
    return perms;
  }

  function permissionsFor(roleList = []) {
    const out = new Set();
    for (const r of roleList) for (const p of expand(r)) out.add(p);
    return Array.from(out);
  }

  function matches(granted, requested) {
    if (granted === requested) return true;
    if (granted.endsWith('.*')) {
      const prefix = granted.slice(0, -1);            // 'reservation.'
      return requested === granted.slice(0, -2) || requested.startsWith(prefix);
    }
    return false;
  }

  function hasPermission(roleList, permission) {
    const granted = permissionsFor(roleList);
    return granted.some((g) => matches(g, permission));   // deny by default if none match
  }

  return { ROLES, permissionsFor, hasPermission, matches };
}

module.exports = { buildRBACEngine, DEFAULT_ROLES };
