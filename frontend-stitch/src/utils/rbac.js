// Client-side RBAC = UX hiding ONLY. The backend remains the source of truth;
// every API call is still guarded server-side and 401/403 are handled centrally.
// This mirrors the platform RBACEngine role->permission defaults so the nav and
// route guards hide sections the user cannot use.

const ROLE_PERMISSIONS = {
  ADMIN: ['admin.*', 'reservation.*', 'billing.*', 'housekeeping.*', 'nightaudit.*', 'revenue.*'],
  FRONT_DESK: ['reservation.*', 'housekeeping.read'],
  HOUSEKEEPING: ['housekeeping.*'],
  ACCOUNTING: ['billing.*', 'nightaudit.read'],
  REVENUE_MANAGER: ['revenue.*', 'reservation.read'],
  AUDITOR: ['nightaudit.*', 'billing.read', 'revenue.read', 'admin.audit.read']
};

function matches(granted, requested) {
  if (granted === requested) return true;
  if (granted.endsWith('.*')) return requested === granted.slice(0, -2) || requested.startsWith(granted.slice(0, -1));
  return false;
}

export function can(principal, permission) {
  if (!permission) return true;                       // public section
  const roles = (principal && principal.roles) || [];
  for (const r of roles) {
    for (const g of (ROLE_PERMISSIONS[r] || [])) if (matches(g, permission)) return true;
  }
  return false;                                        // deny by default
}

/** Filter a nav list down to what the principal may see. */
export function visibleNav(navItems, principal) {
  return (navItems || []).filter((i) => can(principal, i.permission));
}

/** Route access check used by the router guard. */
export function canAccessRoute(route, principal) {
  if (!route) return false;
  if (route.public) return true;
  return can(principal, route.permission);
}

export { ROLE_PERMISSIONS };
