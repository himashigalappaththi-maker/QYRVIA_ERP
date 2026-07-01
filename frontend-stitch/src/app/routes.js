// Route + navigation table. Each module maps to a path, a Material Symbol icon,
// the sidebar `section` it groups under, and the REAL backend permission that
// gates it (used for RBAC nav hiding + route guard). Every permission code here
// exists in the backend permission catalog (migrations 0021 / 0030).

export const ROUTES = [
  { path: '/login',        id: 'login',        label: 'Login',          public: true, hidden: true },

  { path: '/dashboard',    id: 'dashboard',    label: 'Dashboard',      icon: 'dashboard',           section: 'Overview',       permission: null },

  { path: '/booking',      id: 'booking',      label: 'New Booking',    icon: 'add_circle',          section: 'Front Office',   permission: 'pms.reservation.write' },
  { path: '/reservations', id: 'reservations', label: 'Reservations',   icon: 'event_available',     section: 'Front Office',   permission: 'pms.reservation.read' },
  { path: '/groups',       id: 'groups',       label: 'Reservation Groups', icon: 'group_work',      section: 'Front Office',   permission: 'pms.reservation.read' },
  { path: '/frontdesk',    id: 'frontdesk',    label: 'Front Desk',     icon: 'concierge',           section: 'Front Office',   permission: 'pms.reservation.read' },
  { path: '/guests',       id: 'guests',       label: 'Guests',         icon: 'groups',              section: 'Front Office',   permission: 'pms.guest.read' },

  { path: '/rooms',        id: 'rooms',        label: 'Rooms',          icon: 'bed',                 section: 'Inventory & Rates', permission: 'pms.room.read' },
  { path: '/availability', id: 'availability', label: 'Availability',   icon: 'calendar_month',      section: 'Inventory & Rates', permission: 'pms.availability.read' },
  { path: '/rateplans',    id: 'rateplans',    label: 'Rate Plans',     icon: 'sell',                section: 'Inventory & Rates', permission: 'pms.rateplan.read' },

  { path: '/revenue',      id: 'revenue',      label: 'Revenue',        icon: 'trending_up',         section: 'Revenue & Billing', permission: 'revenue.snapshot.read' },
  { path: '/billing',      id: 'billing',      label: 'Billing',        icon: 'receipt_long',        section: 'Revenue & Billing', permission: 'invoice.read' },
  { path: '/vouchers',     id: 'vouchers',     label: 'Vouchers',       icon: 'confirmation_number', section: 'Revenue & Billing', permission: 'voucher.read' },

  { path: '/housekeeping', id: 'housekeeping', label: 'Housekeeping',   icon: 'cleaning_services',   section: 'Operations',     permission: 'housekeeping.read' },
  { path: '/nightaudit',   id: 'nightaudit',   label: 'Night Audit',    icon: 'nightlight',          section: 'Operations',     permission: 'night_audit.read' },
  { path: '/channel',      id: 'channel',      label: 'Channel Manager', icon: 'hub',                section: 'Operations',     permission: 'channel.mapping.read' },

  { path: '/finance',      id: 'finance',      label: 'Accounting',     icon: 'account_balance',     section: 'Finance',        permission: 'cost_center.read' },

  { path: '/control',      id: 'control',      label: 'Control Center', icon: 'tune',                section: 'System',        permission: 'channel.mapping.read' },
  { path: '/users',        id: 'users',        label: 'Users & Roles',  icon: 'manage_accounts',     section: 'System',        permission: 'auth.user.create' },
  { path: '/settings',     id: 'settings',     label: 'Settings',       icon: 'settings',            section: 'System',        permission: 'settings.read' },
  { path: '/connectors',   id: 'connectors',   label: 'Connectors',     icon: 'cable',               section: 'System',        permission: 'connector.configure' },
  { path: '/jobs',         id: 'jobs',         label: 'Jobs',           icon: 'schedule',            section: 'System',        permission: 'jobs.schedule' },
  { path: '/notifications', id: 'notifications', label: 'Notifications', icon: 'notifications',       section: 'System',        permission: 'notifications.read' },
  { path: '/webhooks',     id: 'webhooks',     label: 'Webhooks',       icon: 'webhook',             section: 'System',        permission: 'webhook.manage' },
  { path: '/files',        id: 'files',        label: 'Files',          icon: 'folder',              section: 'System',        permission: 'files.read' },
  { path: '/admin',        id: 'admin',        label: 'Platform Admin', icon: 'admin_panel_settings', section: 'System',        permission: 'bi.dashboard.read' }
];

// Order in which sidebar sections render.
export const SECTION_ORDER = ['Overview', 'Front Office', 'Inventory & Rates', 'Revenue & Billing', 'Operations', 'Finance', 'System'];

const DEFAULT_AUTHED = '/dashboard';

export function resolveRoute(path) {
  const clean = (path || '').split('?')[0] || '/';
  return ROUTES.find((r) => r.path === clean) || null;
}

export function navItems() {
  return ROUTES.filter((r) => !r.hidden);
}

/** Group visible nav items by section, preserving SECTION_ORDER. */
export function navSections(items) {
  const bySection = new Map();
  for (const it of (items || [])) {
    const s = it.section || 'Other';
    if (!bySection.has(s)) bySection.set(s, []);
    bySection.get(s).push(it);
  }
  const ordered = [];
  for (const s of SECTION_ORDER) if (bySection.has(s)) ordered.push({ section: s, items: bySection.get(s) });
  for (const [s, list] of bySection) if (!SECTION_ORDER.includes(s)) ordered.push({ section: s, items: list });
  return ordered;
}

export { DEFAULT_AUTHED };
