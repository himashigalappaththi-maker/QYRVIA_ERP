// Night Audit - business date status + audit execution + history.
import { pageHeader, card, statusBadge, table, btn } from '../../components/ui.js';
import { loadInto } from '../../hooks/useApi.js';
import { on } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';
import { date } from '../../utils/format.js';

export function NightAuditView({ services }) {
  function loadStatus(outlet) {
    loadInto(outlet.querySelector('#na-status'), () => services.nightaudit.status(), (s) => {
      const st = s && (s.result || s);
      return card(`<div class="flex items-center justify-between">
        <div><p class="text-xs uppercase tracking-wider text-slate">Current Business Date</p>
          <p class="font-display text-2xl font-bold mt-1">${date(st && st.currentBusinessDate)}</p>
          <div class="mt-2">${statusBadge(st && st.status)}</div></div>
        ${btn('Run Day-End', { action: 'run-audit', variant: 'primary', icon: 'play_arrow' })}</div>`);
    });
  }
  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Night Audit', 'Day-end & business date control')
        + '<div id="na-status" class="mb-6"></div><h2 class="font-display text-lg font-semibold mb-3">Audit history</h2><div id="na-hist"></div>';
      loadStatus(outlet);
      loadInto(outlet.querySelector('#na-hist'), () => services.nightaudit.history(), (rows) => card(table([
        { key: 'businessDate', label: 'Business Date', render: (r) => date(r.businessDate) },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'startedAt', label: 'Started', render: (r) => date(r.startedAt) }
      ], Array.isArray(rows) ? rows : (rows && rows.result) || [], { empty: 'No audit runs' })));

      on(outlet, '[data-action="run-audit"]', 'click', async () => {
        try { const r = await services.nightaudit.run(); toast(r && r.ok === false ? 'Audit blocked — resolve exceptions' : 'Day-end completed', r && r.ok === false ? 'error' : 'success'); loadStatus(outlet); }
        catch (err) { toast((err && err.message) || 'Audit failed', 'error'); }
      });
    }
  };
}
