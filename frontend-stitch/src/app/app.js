// App bootstrap (browser-only). Wires apiClient + services + session + router +
// layout + views. All routing/auth decisions come from the pure modules.
import { createApiClient } from '../services/apiClient.js';
import { createServices } from '../services/index.js';
import { session } from '../store/session.js';
import { createRouter } from './router.js';
import { renderShell } from '../components/Layout.js';
import { toast } from '../components/Toast.js';

import { LoginView } from '../modules/auth/Login.view.js';
import { DashboardView } from '../modules/dashboard/Dashboard.view.js';
import { FrontDeskView } from '../modules/frontdesk/FrontDesk.view.js';
import { BillingView } from '../modules/billing/Billing.view.js';
import { HousekeepingView } from '../modules/housekeeping/Housekeeping.view.js';
import { RevenueView } from '../modules/revenue/Revenue.view.js';
import { NightAuditView } from '../modules/nightaudit/NightAudit.view.js';
import { AdminView } from '../modules/platform-admin/Admin.view.js';

const appEl = document.getElementById('app');
const VIEWS = {
  login: LoginView, dashboard: DashboardView, frontdesk: FrontDeskView, billing: BillingView,
  housekeeping: HousekeepingView, revenue: RevenueView, nightaudit: NightAuditView, admin: AdminView
};

const api = createApiClient({
  baseUrl: '/api', session,
  onUnauthorized: () => { toast('Session expired — please sign in', 'error'); location.hash = '/login'; },
  onForbidden: () => toast('You do not have access to that action', 'error')
});
const services = createServices(api);

function navigate(to) { router.navigate(to); }

function render(route) {
  const Factory = VIEWS[route.id];
  if (!Factory) return;
  const view = Factory({ services, session, navigate });
  if (route.public) { view.render(appEl); return; }       // login: full screen, no shell
  const outlet = renderShell(appEl, {
    principal: session.getPrincipal(), activeRouteId: route.id,
    onNavigate: navigate, onLogout: () => { session.clear(); navigate('/login'); }
  });
  view.render(outlet);
}

const router = createRouter({
  session, render,
  getPath: () => (location.hash || '').replace(/^#/, '') || '/dashboard',
  setPath: (to) => {
    const target = '#' + to;
    if (location.hash !== target) location.hash = target;    // triggers hashchange -> current()
    else router.current();
  }
});

window.addEventListener('hashchange', () => router.current());
window.addEventListener('DOMContentLoaded', () => router.current());
router.current();
