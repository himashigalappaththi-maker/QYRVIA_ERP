// Revenue - KPIs + pricing calendar (rate grid) + demand view.
import { pageHeader, kpiCard, card, table } from '../../components/ui.js';
import { loadInto } from '../../hooks/useApi.js';
import { money, pct, date } from '../../utils/format.js';

export function RevenueView({ services }) {
  return {
    render(outlet) {
      // default a 7-day window from "today" for the grid (deterministic display only)
      const start = new Date().toISOString().slice(0, 10);
      const endD = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);

      outlet.innerHTML = pageHeader('Revenue Management', 'Dynamic pricing & forecasting')
        + '<div id="rev-kpis" class="mb-6"></div><div id="rev-grid"></div>';

      loadInto(outlet.querySelector('#rev-kpis'), () => services.revenue.kpis({}), (k) => `
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          ${kpiCard({ label: 'ADR', value: money(k.adr), icon: 'payments' })}
          ${kpiCard({ label: 'RevPAR', value: money(k.revpar), icon: 'trending_up' })}
          ${kpiCard({ label: 'Occupancy', value: pct(k.occupancyPct), icon: 'bed' })}
        </div>`);

      loadInto(outlet.querySelector('#rev-grid'),
        () => services.revenue.rateGrid({ room_type_id: 'STD', date_from: start, date_to: endD }),
        (grid) => `<h2 class="font-display text-lg font-semibold mb-3">Pricing calendar — STD</h2>` + card(table([
          { key: 'businessDate', label: 'Date', render: (r) => date(r.businessDate) },
          { key: 'computedRate', label: 'Rate', render: (r) => money(r.computedRate) },
          { key: 'demandScore', label: 'Demand' },
          { key: 'seasonalMultiplier', label: 'Seasonal' },
          { key: 'confidenceScore', label: 'Confidence' }
        ], Array.isArray(grid) ? grid : (grid && grid.result) || [], { empty: 'No pricing data (set a rate plan first)' })));
    }
  };
}
