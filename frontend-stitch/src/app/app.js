// App bootstrap (browser-only). Wires apiClient + services + session + router +
// layout + views. All routing/auth decisions come from the pure modules.
import { createApiClient } from '../services/apiClient.js';
import { createServices } from '../services/index.js';
import { session } from '../store/session.js';
import { createRouter } from './router.js';
import { renderShell } from '../components/Layout.js';
import { openPropertySwitcher } from '../components/PropertySwitcher.js';
import { toast } from '../components/Toast.js';

import { LoginView }                  from '../modules/auth/Login.view.js';
import { PropertySelectorView }        from '../modules/auth/PropertySelector.view.js';
import { CompletePasswordResetView }   from '../modules/auth/CompletePasswordReset.view.js';
import { AcceptInvitationView }        from '../modules/auth/AcceptInvitation.view.js';
import { RequestPasswordResetView }    from '../modules/auth/RequestPasswordReset.view.js';
import { DashboardView } from '../modules/dashboard/Dashboard.view.js';
import { BookingView } from '../modules/booking/Booking.view.js';
import { ReservationsView } from '../modules/reservations/Reservations.view.js';
import { FrontDeskView } from '../modules/frontdesk/FrontDesk.view.js';
import { GuestsView } from '../modules/guests/Guests.view.js';
import { RoomsView } from '../modules/rooms/Rooms.view.js';
import { AvailabilityView } from '../modules/availability/Availability.view.js';
import { RatePlansView } from '../modules/rateplans/RatePlans.view.js';
import { RevenueView } from '../modules/revenue/Revenue.view.js';
import { BillingView } from '../modules/billing/Billing.view.js';
import { HousekeepingView } from '../modules/housekeeping/Housekeeping.view.js';
import { NightAuditView } from '../modules/nightaudit/NightAudit.view.js';
import { ChannelView } from '../modules/channel/Channel.view.js';
import { ControlView } from '../modules/control/Control.view.js';
import { FinanceView } from '../modules/finance/Finance.view.js';
import { AdminView } from '../modules/platform-admin/Admin.view.js';
// Phase 36 - migrated back-office + gap-closure screens.
import { UsersView } from '../modules/iam/Users.view.js';
import { SettingsView } from '../modules/settings/Settings.view.js';
import { VouchersView } from '../modules/vouchers/Vouchers.view.js';
import { GroupsView } from '../modules/groups/Groups.view.js';
import { JobsView } from '../modules/jobs/Jobs.view.js';
import { NotificationsView } from '../modules/notifications/Notifications.view.js';
import { WebhooksView } from '../modules/webhooks/Webhooks.view.js';
import { FilesView } from '../modules/files/Files.view.js';
import { ConnectorsView } from '../modules/connectors/Connectors.view.js';

const appEl = document.getElementById('app');
const VIEWS = {
  login: LoginView,
  // Phase 57: auth flow screens
  'select-property':         PropertySelectorView,
  'complete-password-reset': CompletePasswordResetView,
  'accept-invitation':       AcceptInvitationView,
  'reset-password':          RequestPasswordResetView,
  dashboard: DashboardView, booking: BookingView,
  reservations: ReservationsView, frontdesk: FrontDeskView, guests: GuestsView,
  rooms: RoomsView, availability: AvailabilityView, rateplans: RatePlansView,
  revenue: RevenueView, billing: BillingView,
  housekeeping: HousekeepingView, nightaudit: NightAuditView, channel: ChannelView,
  control: ControlView, finance: FinanceView, admin: AdminView,
  // Phase 36
  users: UsersView, settings: SettingsView, vouchers: VouchersView, groups: GroupsView,
  jobs: JobsView, notifications: NotificationsView, webhooks: WebhooksView,
  files: FilesView, connectors: ConnectorsView
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
    onNavigate: navigate,
    onLogout: () => { try { services.auth.logout(session.load() && session.load().refreshToken); } catch (_) {} session.clear(); navigate('/login'); },
    onOpenPropertySwitcher: () => openPropertySwitcher({ services, session, onSwitched: () => router.current() })
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
