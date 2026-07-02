// Webhooks - list endpoints, register a new one, disable, and drain deliveries.
// Backed by /api/webhooks.
import { pageHeader, card, table, statusBadge, btn, field, textareaField, modal, loading, errorState } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, datetime } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

export function WebhooksView({ services, session }) {
  const canManage = can(session.getPrincipal(), 'webhook.manage');

  function load(outlet) {
    const body = outlet.querySelector('#wh-body');
    body.innerHTML = loading();
    services.webhooks.list().then((res) => {
      body.innerHTML = card(table([
        { key: 'name', label: 'Name', render: (r) => dash(r.name) },
        { key: 'url', label: 'URL', render: (r) => `<span class="font-mono text-xs break-all">${dash(r.url)}</span>` },
        { key: 'event_types', label: 'Events', render: (r) => dash(Array.isArray(r.event_types) && r.event_types.length ? r.event_types.join(', ') : 'all') },
        { key: 'is_active', label: 'Status', render: (r) => statusBadge(r.is_active ? 'OPEN' : 'CLOSED') },
        { key: 'created_at', label: 'Created', render: (r) => datetime(r.created_at) },
        { key: '_act', label: '', tdClass: 'text-right', render: (r) => (canManage && r.is_active ? btn('Disable', { action: 'wh-disable', id: r.id, variant: 'danger', icon: 'block' }) : '') }
      ], asArray(res), { empty: 'No webhook endpoints' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load webhooks'); });
  }

  function openRegister(outlet) {
    openOverlay(modal({ id: 'whnew', title: 'Register Webhook', size: 'max-w-xl', body: `<form id="whform" class="space-y-4">
      ${field({ name: 'name', label: 'Name', required: true })}
      ${field({ name: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://…' })}
      ${field({ name: 'event_types', label: 'Event types (comma-separated, blank = all)', placeholder: 'reservation.created, invoice.issued' })}
    </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Register', { action: 'whnew-go', icon: 'webhook' })}` }), (root) => {
      on(root, '[data-action="whnew-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(root.querySelector('#whform')).entries());
        if (!d.name || !d.url) { toast('Name and URL required', 'error'); return; }
        const body = { name: d.name, url: d.url, event_types: d.event_types ? d.event_types.split(',').map((s) => s.trim()).filter(Boolean) : [] };
        try { const r = asObject(await services.webhooks.register(body)); toast('Endpoint registered' + (r.secret ? ' — secret: ' + r.secret : ''), 'success'); closeOverlay(); load(outlet); }
        catch (e) { toast((e && e.message) || 'Register failed', 'error'); }
      });
    });
  }

  return {
    render(outlet) {
      const actions = canManage ? btn('Register', { action: 'wh-new', icon: 'add' }) + btn('Deliver pending', { action: 'wh-drain', variant: 'secondary', icon: 'outbox' }) : '';
      outlet.innerHTML = pageHeader('Webhooks', 'Outbound event subscriptions', actions) + `<div id="wh-body"></div>`;
      load(outlet);
      on(outlet, '[data-action="wh-new"]', 'click', () => openRegister(outlet));
      on(outlet, '[data-action="wh-disable"]', 'click', async (e, t) => {
        try { await services.webhooks.disable(t.getAttribute('data-id')); toast('Endpoint disabled', 'success'); load(outlet); }
        catch (err) { toast((err && err.message) || 'Disable failed', 'error'); }
      });
      on(outlet, '[data-action="wh-drain"]', 'click', async () => {
        try { const r = await services.webhooks.deliverPending(); toast('Deliveries run' + (r && r.delivered != null ? ' (' + r.delivered + ')' : ''), 'success'); }
        catch (err) { toast((err && err.message) || 'Delivery failed', 'error'); }
      });
    }
  };
}
