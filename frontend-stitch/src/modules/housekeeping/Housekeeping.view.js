// Housekeeping - task board + room-status dashboard.
import { pageHeader, card, statusBadge, table } from '../../components/ui.js';
import { loadInto } from '../../hooks/useApi.js';
import { esc } from '../../utils/dom.js';
import { titleCase } from '../../utils/format.js';

export function HousekeepingView({ services }) {
  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Housekeeping', 'Task board & room readiness') + '<div id="hk"></div>';
      loadInto(outlet.querySelector('#hk'), () => services.housekeeping.tasks({}), (rows) => {
        const tasks = Array.isArray(rows) ? rows : (rows && rows.result) || [];
        const byStatus = {};
        for (const t of tasks) { (byStatus[t.status] = byStatus[t.status] || []).push(t); }
        const columns = ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'];
        const board = columns.map((c) => `
          <div class="bg-surface-container rounded-xl p-4">
            <p class="text-xs uppercase tracking-wider text-slate mb-3">${esc(titleCase(c))} (${(byStatus[c] || []).length})</p>
            <div class="space-y-2">${(byStatus[c] || []).map((t) => card(
              `<p class="text-sm font-medium">${esc(t.taskType || 'Task')}</p>
               <p class="text-xs text-slate">Room ${esc(t.roomId)} · priority ${esc(t.priority)}</p>`, 'p-3').replace('shadow-card', 'shadow-none border border-outline-variant/40')).join('') || '<p class="text-xs text-slate">—</p>'}</div>
          </div>`).join('');
        return `<div class="grid grid-cols-1 md:grid-cols-4 gap-4">${board}</div>`;
      });
    }
  };
}
