// Client-side RBAC = UX hiding ONLY. The backend remains the source of truth;
// every API call is still authorized server-side and 401/403 handled centrally.
//
// Alignment (Phase 20A): this now matches the ACTUAL backend authorization model:
//   1. The login/me response carries a real `permissions` array (codes such as
//      `pms.reservation.read`, `folio.post`, `cost_center.read`, `bi.dashboard.read`).
//      When present it is authoritative.
//   2. The backend grants every reserved permission to super_admin / corporate_admin
//      / property_admin (migration 0030) and bypasses checks for super_admin — we
//      mirror that as a role bypass.
//   3. A best-effort role->permission fallback covers principals issued without an
//      explicit permissions array.

const SUPER_ROLES = new Set(['super_admin', 'corporate_admin', 'property_admin']);

// Fallback only (real role codes -> permission globs). Authoritative path is the
// principal.permissions array returned by the backend.
const ROLE_PERMISSIONS = {
  front_office_manager: ['pms.reservation.*', 'pms.guest.*', 'pms.room.read', 'pms.availability.read',
                         'pms.rateplan.read', 'folio.*', 'invoice.read', 'housekeeping.*',
                         'night_audit.read', 'bi.dashboard.read', 'channel.mapping.read'],
  front_desk:          ['pms.reservation.*', 'pms.guest.*', 'pms.room.read', 'pms.availability.read', 'folio.read', 'housekeeping.read'],
  housekeeping:        ['housekeeping.*', 'pms.room.read'],
  accountant:          ['invoice.*', 'folio.read', 'cost_center.*', 'revenue_map.*', 'ledger.*', 'night_audit.read'],
  revenue_manager:     ['revenue.snapshot.*', 'pms.reservation.read', 'pms.rateplan.read', 'bi.dashboard.read'],
  auditor:             ['night_audit.*', 'invoice.read', 'folio.read', 'revenue.snapshot.read', 'bi.dashboard.read', 'ledger.read']
};

export function matchPerm(granted, requested) {
  if (granted === requested || granted === '*') return true;
  if (granted.endsWith('.*')) {
    const prefix = granted.slice(0, -1);              // 'pms.*' -> 'pms.'
    return requested === granted.slice(0, -2) || requested.startsWith(prefix);
  }
  return false;
}

export function can(principal, permission) {
  if (!permission) return true;                        // public / always-visible
  const roles = (principal && principal.roles) || [];
  if (roles.some((r) => SUPER_ROLES.has(String(r)))) return true;

  const perms = (principal && principal.permissions) || [];
  if (perms.length) return perms.some((g) => matchPerm(String(g), permission));

  for (const r of roles) {
    for (const g of (ROLE_PERMISSIONS[String(r)] || [])) if (matchPerm(g, permission)) return true;
  }
  return false;                                        // deny by default
}

/** Filter a nav list (flat or sectioned) down to what the principal may see. */
export function visibleNav(navItems, principal) {
  return (navItems || []).filter((i) => can(principal, i.permission));
}

/** Route access check used by the router guard. */
export function canAccessRoute(route, principal) {
  if (!route) return false;
  if (route.public) return true;
  return can(principal, route.permission);
}

export { ROLE_PERMISSIONS, SUPER_ROLES };
