// Dashboard - operational + revenue overview aggregated from existing reads:
// reservation snapshot (pms), revenue KPIs (revenue), platform metrics (when the
// user can read them). Tiles deep-link into the relevant module.
import { pageHeader, card, kpiCard, sectionTitle, loading } from '../../components/ui.js';
import { on } from '../../utils/dom.js';
import { money, pct, num, titleCase, isoDay } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';
import { deriveArrivals, deriveDepartures, deriveInHouse, countByStatus } from '../frontdesk/logic.js';

export function DashboardView({ services, session, navigate }) {
  const principal = session.getPrincipal();
  const canResv = can(principal, 'pms.reservation.read');
  const canRev = can(principal, 'revenue.snapshot.read');
  const canMetrics = can(principal, 'bi.dashboard.read');
  const today = isoDay(0);

  function loadOps(outlet) {
    const el = outlet.querySelector('#dash-ops');
    if (!canResv) { el.innerHTML = ''; return; }
    services.reservations.list({}).then((r) => {
      const rows = asArray(r);
      const a = deriveArrivals(rows, today).length;
      const d = deriveDepartures(rows, today).length;
      const ih = deriveInHouse(rows).length;
      const byStatus = countByStatus(rows);
      el.innerHTML = sectionTitle('Front Office — ' + today) + `<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        ${kpiCard({ label: 'Arrivals', value: a, icon: 'login' })}
        ${kpiCard({ label: 'Departures', value: d, icon: 'logout' })}
        ${kpiCard({ label: 'In-House', value: ih, icon: 'hotel' })}
        ${kpiCard({ label: 'Confirmed', value: byStatus.CONFIRMED || 0, icon: 'event_available' })}
      </div>`;
    }).catch(() => { el.innerHTML = ''; });
  }

  function loadRevenue(outlet) {
    const el = outlet.querySelector('#dash-rev');
    if (!canRev) { el.innerHTML = ''; return; }
    services.revenue.kpis({}).then((r) => {
      const k = asObject(r);
      const tiles = [];
      if (k.adr != null) tiles.push(kpiCard({ label: 'ADR', value: money(k.adr), icon: 'payments' }));
      if (k.revpar != null) tiles.push(kpiCard({ label: 'RevPAR', value: money(k.revpar), icon: 'trending_up' }));
      if (k.occupancyPct != null) tiles.push(kpiCard({ label: 'Occupancy', value: pct(k.occupancyPct <= 1.5 ? k.occupancyPct * 100 : k.occupancyPct), icon: 'bed' }));
      if (k.roomRevenue != null) tiles.push(kpiCard({ label: 'Room Revenue', value: money(k.roomRevenue), icon: 'account_balance' }));
      if (!tiles.length) Object.entries(k).filter(([, v]) => typeof v !== 'object').slice(0, 4).forEach(([kk, v]) => tiles.push(kpiCard({ label: titleCase(kk), value: num(v), icon: 'insights' })));
      el.innerHTML = tiles.length ? sectionTitle('Revenue') + `<div class="grid grid-cols-2 md:grid-cols-4 gap-4">${tiles.join('')}</div>` : '';
    }).catch(() => { el.innerHTML = ''; });
  }

  function loadMetrics(outlet) {
    const el = outlet.querySelector('#dash-metrics');
    if (!canMetrics) { el.innerHTML = ''; return; }
    services.platform.metrics().then((r) => {
      const snap = asObject(r);
      const counters = snap.counters || snap;
      const rows = Object.entries(counters).filter(([, v]) => typeof v !== 'object').slice(0, 4);
      el.innerHTML = rows.length ? sectionTitle('Platform') + `<div class="grid grid-cols-2 md:grid-cols-4 gap-4">${rows.map(([k, v]) => kpiCard({ label: titleCase(k), value: num(v), icon: 'monitoring' })).join('')}</div>` : '';
    }).catch(() => { el.innerHTML = ''; });
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Dashboard', 'Operational & revenue overview')
        + '<div id="dash-ops" class="mb-6"></div><div id="dash-rev" class="mb-6"></div><div id="dash-metrics" class="mb-6"></div>'
        + card('<p class="text-slate text-sm">QYRVIA backend is the system of record; this UI is a live visualization layer. Use the sidebar to manage reservations, front desk, billing, housekeeping, revenue, night audit and platform administration.</p>');
      loadOps(outlet); loadRevenue(outlet); loadMetrics(outlet);
    }
  };
}
