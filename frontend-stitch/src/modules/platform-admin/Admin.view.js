// Platform Admin - metrics, audit, integrations, properties.
import { pageHeader, card, table, statusBadge } from '../../components/ui.js';
import { loadInto } from '../../hooks/useApi.js';
import { esc } from '../../utils/dom.js';
import { date } from '../../utils/format.js';

export function AdminView({ services }) {
  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Platform Admin', 'Observability, integrations & properties')
        + '<div id="ad-metrics" class="mb-6"></div>'
        + '<div class="grid grid-cols-1 lg:grid-cols-2 gap-6"><div id="ad-integrations"></div><div id="ad-props"></div></div>'
        + '<div id="ad-audit" class="mt-6"></div>';

      loadInto(outlet.querySelector('#ad-metrics'), () => services.platform.metrics(), (m) => {
        const snap = (m && (m.result || m)) || {};
        const counters = snap.counters || {};
        const rows = Object.entries(counters).map(([k, v]) => ({ metric: k, value: v }));
        return `<h2 class="font-display text-lg font-semibold mb-3">Metrics</h2>` + card(table(
          [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }], rows, { empty: 'No metrics yet' }));
      });

      loadInto(outlet.querySelector('#ad-integrations'), () => services.platform.integrations(), (list) =>
        `<h2 class="font-display text-lg font-semibold mb-3">Integrations</h2>` + card(table([
          { key: 'id', label: 'System' }, { key: 'type', label: 'Type' },
          { key: 'enabled', label: 'Status', render: (r) => statusBadge(r.enabled ? 'OPEN' : 'CLOSED') }
        ], norm(list), { empty: 'No integrations registered' })));

      loadInto(outlet.querySelector('#ad-props'), () => services.platform.properties(), (list) =>
        `<h2 class="font-display text-lg font-semibold mb-3">Properties</h2>` + card(table([
          { key: 'propertyId', label: 'Property' }, { key: 'name', label: 'Name' }, { key: 'timezone', label: 'Timezone' }
        ], norm(list), { empty: 'No properties registered' })));

      loadInto(outlet.querySelector('#ad-audit'), () => services.platform.audit({}), (list) =>
        `<h2 class="font-display text-lg font-semibold mb-3">Audit stream</h2>` + card(table([
          { key: 'type', label: 'Event', render: (r) => esc(r.type) },
          { key: 'propertyId', label: 'Property' },
          { key: 'userId', label: 'User' },
          { key: 'at', label: 'When', render: (r) => date(r.at) }
        ], norm(list).slice(-25), { empty: 'No audit entries' })));
    }
  };
}

function norm(x) { return Array.isArray(x) ? x : (x && x.result) || []; }
