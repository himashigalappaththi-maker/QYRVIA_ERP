// Billing - folios + invoices.
import { pageHeader, table, statusBadge, card } from '../../components/ui.js';
import { loadInto } from '../../hooks/useApi.js';
import { money, date } from '../../utils/format.js';

export function BillingView({ services }) {
  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Billing', 'Folios, invoices & payments')
        + '<div id="folios" class="mb-6"></div><div id="invoices"></div>';

      loadInto(outlet.querySelector('#folios'), () => services.billing.folios({}), (rows) =>
        `<h2 class="font-display text-lg font-semibold mb-3">Folios</h2>` + card(table([
          { key: 'folioId', label: 'Folio' },
          { key: 'stayId', label: 'Stay' },
          { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
          { key: 'currency', label: 'Currency' }
        ], normalize(rows), { empty: 'No folios' })));

      loadInto(outlet.querySelector('#invoices'), () => services.billing.invoices({}), (rows) =>
        `<h2 class="font-display text-lg font-semibold mb-3">Invoices</h2>` + card(table([
          { key: 'number', label: 'Invoice #' },
          { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
          { key: 'total', label: 'Total', render: (r) => money(r.total) },
          { key: 'finalizedAt', label: 'Finalized', render: (r) => date(r.finalizedAt) }
        ], normalize(rows), { empty: 'No invoices' })));
    }
  };
}

function normalize(rows) { return Array.isArray(rows) ? rows : (rows && rows.result) || []; }
