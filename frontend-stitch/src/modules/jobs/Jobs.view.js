// Jobs - schedule a job, cancel a pending job by id, and run the due-job loop.
// The backend exposes no job-list endpoint, so this is a control panel.
import { pageHeader, card, sectionTitle, btn, field, textareaField, infoBanner } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { can } from '../../utils/rbac.js';

export function JobsView({ services, session }) {
  const canManage = can(session.getPrincipal(), 'jobs.schedule');

  return {
    render(outlet) {
      if (!canManage) { outlet.innerHTML = pageHeader('Jobs', 'Scheduler') + card(infoBanner('You do not have permission to manage jobs.', 'lock')); return; }
      outlet.innerHTML = pageHeader('Jobs', 'Scheduler control panel')
        + card(sectionTitle('Schedule a job') + `<form id="jform" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${field({ name: 'job_type', label: 'Job type', required: true, placeholder: 'e.g. pms.night_audit' })}
            ${field({ name: 'run_at', label: 'Run at', type: 'datetime-local' })}
            ${field({ name: 'max_attempts', label: 'Max attempts', type: 'number', value: '3' })}
            ${textareaField({ name: 'payload', label: 'Payload (JSON)', placeholder: '{}' })}
          </form><div class="flex justify-end gap-2 mt-4">${btn('Schedule', { action: 'j-schedule', icon: 'schedule_send' })}</div>`, 'mb-5')
        + card(sectionTitle('Operations') + `<div class="flex flex-wrap items-end gap-3">
            ${field({ name: 'cancel_id', label: 'Cancel job id', placeholder: 'Pending job id' })}
            <div>${btn('Cancel job', { action: 'j-cancel', variant: 'danger', icon: 'cancel' })}</div>
            <div class="ml-auto">${btn('Run due jobs', { action: 'j-run', variant: 'secondary', icon: 'play_arrow' })}</div>
          </div>`);

      on(outlet, '[data-action="j-schedule"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(outlet.querySelector('#jform')).entries());
        if (!d.job_type) { toast('Job type required', 'error'); return; }
        let payload = {}; if (d.payload) { try { payload = JSON.parse(d.payload); } catch (_) { toast('Payload must be valid JSON', 'error'); return; } }
        const body = { job_type: d.job_type, payload, max_attempts: Number(d.max_attempts) || 3 };
        if (d.run_at) body.run_at = new Date(d.run_at).toISOString();
        try { const r = await services.jobs.schedule(body); toast('Job scheduled' + (r && r.id ? ' (' + r.id + ')' : ''), 'success'); outlet.querySelector('#jform').reset(); }
        catch (e) { toast((e && e.message) || 'Schedule failed', 'error'); }
      });
      on(outlet, '[data-action="j-cancel"]', 'click', async () => {
        const id = (outlet.querySelector('[name="cancel_id"]') || {}).value;
        if (!id) { toast('Enter a job id', 'error'); return; }
        try { const r = await services.jobs.cancel(id); toast(r && r.ok === false ? (r.error || 'Not cancellable') : 'Job cancelled', r && r.ok === false ? 'error' : 'success'); }
        catch (e) { toast((e && e.message) || 'Cancel failed', 'error'); }
      });
      on(outlet, '[data-action="j-run"]', 'click', async () => {
        try { const r = await services.jobs.run(); toast(`Ran due jobs (picked ${r && r.picked != null ? r.picked : '?'})`, 'success'); }
        catch (e) { toast((e && e.message) || 'Run failed', 'error'); }
      });
    }
  };
}
