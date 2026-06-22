// Route + navigation table. Each module maps to a path, a Material Symbol icon,
// and the backend permission that gates it (used for nav hiding + route guard).

export const ROUTES = [
  { path: '/login',        id: 'login',        label: 'Login',         public: true,  hidden: true },
  { path: '/dashboard',    id: 'dashboard',    label: 'Dashboard',     icon: 'dashboard',          permission: null },
  { path: '/frontdesk',    id: 'frontdesk',    label: 'Front Desk',    icon: 'concierge',          permission: 'reservation.read' },
  { path: '/billing',      id: 'billing',      label: 'Billing',       icon: 'receipt_long',       permission: 'billing.read' },
  { path: '/housekeeping', id: 'housekeeping', label: 'Housekeeping',  icon: 'cleaning_services',  permission: 'housekeeping.read' },
  { path: '/revenue',      id: 'revenue',      label: 'Revenue',       icon: 'trending_up',        permission: 'revenue.read' },
  { path: '/nightaudit',   id: 'nightaudit',   label: 'Night Audit',   icon: 'nightlight',         permission: 'nightaudit.read' },
  { path: '/admin',        id: 'admin',        label: 'Admin',         icon: 'admin_panel_settings', permission: 'admin.audit.read' }
];

const DEFAULT_AUTHED = '/dashboard';

export function resolveRoute(path) {
  const clean = (path || '').split('?')[0] || '/';
  return ROUTES.find((r) => r.path === clean) || null;
}

export function navItems() {
  return ROUTES.filter((r) => !r.hidden);
}

export { DEFAULT_AUTHED };
