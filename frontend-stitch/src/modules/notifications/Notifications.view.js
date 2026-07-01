// Notifications - list/filter outbound notifications, view detail, request a new
// one, and drain the pending queue. Backed by /api/notifications.
import { pageHeader, card, table, statusBadge, btn, field, selectField, textareaField, drawer, definitionList, modal, toolbar, loading, errorState } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, titleCase, datetime } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const STATUSES = ['pending', 'sending', 'delivered', 'failed', 'not_configured', 'cancelled'];
const CHANNELS = ['email', 'sms', 'whatsapp', 'webhook'];

export function NotificationsView({ services, session }) {
  const canSend = can(session.getPrincipal(), 'notifications.send');

  function load(outlet) {
    const body = outlet.querySelector('#n-body');
    const status = (outlet.querySelector('[name="nstatus"]') || {}).value || undefined;
    body.innerHTML = loading();
    services.notifications.list({ status }).then((res) => {
      body.innerHTML = card(table([
        { key: 'channel', label: 'Channel', render: (r) => titleCase(r.channel) },
        { key: 'template_code', label: 'Template', render: (r) => dash(r.template_code) },
        { key: 'recipient', label: 'Recipient', render: (r) => `<button data-nid="${r.id}" class="text-primary hover:underline">${dash(r.recipient)}</button>` },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'requested_at', label: 'Requested', render: (r) => datetime(r.requested_at) }
      ], asArray(res), { empty: 'No notifications' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load notifications'); });
  }

  function openDetail(outlet, id) {
    openOverlay(drawer({ id: 'n', title: 'Notification', body: `<div id="n-detail">${loading()}</div>` }), async (root) => {
      const el = root.querySelector('#n-detail');
      try {
        const n = asObject(await services.notifications.byId(id));
        el.innerHTML = definitionList([
          ['Channel', titleCase(n.channel)], ['Template', dash(n.template_code)],
          ['Recipient', dash(n.recipient)], ['Subject', dash(n.subject)],
          ['Status', statusBadge(n.status)], ['Requested', datetime(n.requested_at)],
          ['Completed', datetime(n.completed_at)], ['Body', dash(n.body)]
        ]);
      } catch (e) { el.innerHTML = `<p class="text-error text-sm">${(e && e.message) || 'Failed'}</p>`; }
    });
  }

  function openRequest(outlet) {
    openOverlay(modal({ id: 'nnew', title: 'Request Notification', size: 'max-w-xl', body: `<form id="nform" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${selectField({ name: 'channel', label: 'Channel', value: 'email', placeholder: '', options: CHANNELS.map((c) => ({ value: c, label: titleCase(c) })) })}
      ${field({ name: 'template_code', label: 'Template code' })}
      ${field({ name: 'recipient', label: 'Recipient', required: true })}
      ${field({ name: 'subject', label: 'Subject' })}
      ${textareaField({ name: 'body', label: 'Body' })}
    </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Queue notification', { action: 'nnew-go', icon: 'send' })}` }), (root) => {
      on(root, '[data-action="nnew-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(root.querySelector('#nform')).entries());
        if (!d.recipient) { toast('Recipient required', 'error'); return; }
        try { await services.notifications.request(d); toast('Notification queued', 'success'); closeOverlay(); load(outlet); }
        catch (e) { toast((e && e.message) || 'Request failed', 'error'); }
      });
    });
  }

  return {
    render(outlet) {
      const actions = (canSend ? btn('New', { action: 'n-new', icon: 'add' }) + btn('Send pending', { action: 'n-drain', variant: 'secondary', icon: 'outbox' }) : '');
      outlet.innerHTML = pageHeader('Notifications', 'Outbound message queue', actions)
        + `<form id="n-filters">${toolbar(`
            ${selectField({ name: 'nstatus', label: 'Status', placeholder: 'All', options: STATUSES.map((s) => ({ value: s, label: titleCase(s) })) })}
            <div>${btn('Filter', { action: 'n-apply', icon: 'filter_list' })}</div>`)}</form>
          <div id="n-body"></div>`;
      load(outlet);
      on(outlet, '[data-action="n-apply"]', 'click', (e) => { e.preventDefault(); load(outlet); });
      on(outlet, '#n-filters', 'submit', (e) => { e.preventDefault(); load(outlet); });
      on(outlet, '[data-nid]', 'click', (e, t) => openDetail(outlet, t.getAttribute('data-nid')));
      on(outlet, '[data-action="n-new"]', 'click', () => openRequest(outlet));
      on(outlet, '[data-action="n-drain"]', 'click', async () => {
        try { const r = await services.notifications.sendPending(); toast('Queue drained' + (r && r.sent != null ? ' (' + r.sent + ')' : ''), 'success'); load(outlet); }
        catch (e) { toast((e && e.message) || 'Drain failed', 'error'); }
      });
    }
  };
}
