// Night Audit / Day-End - trigger a run, configure the schedule, and review the
// recent audit-event stream (filtered to audit-relevant events). The backend
// exposes run + schedule writes but no status/history read, so recent activity
// is sourced from the platform audit stream when the user can read it.
import { pageHeader, card, btn, field, selectField, table, sectionTitle, loading, infoBanner, emptyState } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { datetime, dash, isoDay } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const AUDIT_EVENTS = /night_audit|reservation\.checked|folio\.(opened|closed)|business_date/i;

export function NightAuditView({ services, session }) {
  const principal = session.getPrincipal();
  const canRun = can(principal, 'night_audit.run');
  const canConfig = can(principal, 'night_audit.config');
  const canAudit = can(principal, 'bi.dashboard.read');

  function loadActivity(outlet) {
    const el = outlet.querySelector('#na-activity');
    if (!canAudit) { el.innerHTML = card(emptyState('Recent activity requires audit access (bi.dashboard.read).', 'lock')); return; }
    el.innerHTML = loading();
    services.platform.audit({}).then((r) => {
      const rows = asArray(r).filter((x) => AUDIT_EVENTS.test(String(x.type || x.event_type || '')));
      el.innerHTML = card(sectionTitle('Recent audit activity') + table([
        { key: 'type', label: 'Event', render: (x) => dash(x.type || x.event_type) },
        { key: 'propertyId', label: 'Property', render: (x) => dash(x.propertyId || x.property_id) },
        { key: 'userId', label: 'User', render: (x) => dash(x.userId || x.user_id) },
        { key: 'at', label: 'When', render: (x) => datetime(x.at || x.created_at) }
      ], rows.slice(-30).reverse(), { empty: 'No recent audit-relevant events' }));
    }).catch(() => { el.innerHTML = card(emptyState('Audit stream unavailable', 'info')); });
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Night Audit', 'Business-date roll, financial lock & day-end')
        + infoBanner('The backend does not expose a night-audit status read; current state is reflected via the audit activity stream below.', 'nightlight')
        + `<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div>${card(sectionTitle('Run night audit') + `
              <form id="na-run" class="space-y-4">
                ${field({ name: 'business_date', label: 'Business date (optional)', type: 'date', value: isoDay(0) })}
                ${canRun ? btn('Run Night Audit', { action: 'na-run-go', icon: 'play_arrow' }) : infoBanner('You do not have permission to run the night audit.', 'lock')}
              </form>`)}</div>
            <div>${card(sectionTitle('Schedule') + `
              <form id="na-sched" class="space-y-4">
                ${field({ name: 'run_at', label: 'Daily run time (HH:MM)', type: 'time', value: '03:00' })}
                ${selectField({ name: 'enabled', label: 'Enabled', value: 'true', placeholder: '', options: [{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }] })}
                ${canConfig ? btn('Save schedule', { action: 'na-sched-go', icon: 'schedule' }) : infoBanner('You do not have permission to configure the schedule.', 'lock')}
              </form>`)}</div>
          </div>`
        + '<div id="na-activity"></div>';

      loadActivity(outlet);

      on(outlet, '[data-action="na-run-go"]', 'click', async (e) => {
        e.preventDefault();
        const bd = (outlet.querySelector('[name="business_date"]') || {}).value;
        try { const r = asObject(await services.nightAudit.run(bd ? { business_date: bd } : {})); toast('Night audit triggered' + (r.status ? ' — ' + r.status : ''), 'success'); loadActivity(outlet); }
        catch (err) { toast((err && err.message) || 'Run failed', 'error'); }
      });
      on(outlet, '[data-action="na-sched-go"]', 'click', async (e) => {
        e.preventDefault();
        const runAt = (outlet.querySelector('[name="run_at"]') || {}).value;
        const enabled = (outlet.querySelector('[name="enabled"]') || {}).value === 'true';
        try { await services.nightAudit.schedule({ run_at: runAt, enabled }); toast('Schedule saved', 'success'); }
        catch (err) { toast((err && err.message) || 'Save failed', 'error'); }
      });
    }
  };
}
