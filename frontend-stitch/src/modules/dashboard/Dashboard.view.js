// Dashboard - high-level KPIs (revenue) + quick module entry points.
import { pageHeader, kpiCard, card } from '../../components/ui.js';
import { loadInto } from '../../hooks/useApi.js';
import { money, pct } from '../../utils/format.js';

export function DashboardView({ services }) {
  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Dashboard', 'Operational & revenue overview') + '<div id="kpis"></div>';
      loadInto(outlet.querySelector('#kpis'), () => services.revenue.kpis({}), (k) => `
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
          ${kpiCard({ label: 'ADR', value: money(k.adr), icon: 'payments' })}
          ${kpiCard({ label: 'RevPAR', value: money(k.revpar), icon: 'trending_up' })}
          ${kpiCard({ label: 'Occupancy', value: pct(k.occupancyPct), icon: 'bed' })}
          ${kpiCard({ label: 'Room Revenue', value: money(k.roomRevenue), icon: 'account_balance' })}
        </div>
        <div class="mt-6">${card('<p class="text-slate text-sm">Use the sidebar to manage front desk, billing, housekeeping, revenue, night audit and platform administration. The backend is the system of record; this UI is a visualization layer.</p>')}</div>`);
    }
  };
}
