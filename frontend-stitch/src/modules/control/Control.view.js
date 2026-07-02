// Control Center (Phase 25) - operational view of the Channel Manager / OTA +
// persistence subsystems. Read-mostly: surfaces non-secret status (sync channels,
// persistence mode, worker/webhook/HTTP flags, credential-provider presence,
// mapping count, queue depth) plus manual sync triggers. Backed by GET
// /api/channel/control + /channel/sync/*.
import { pageHeader, card, table, statusBadge, btn, sectionTitle, loading, errorState, infoBanner } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash } from '../../utils/format.js';
import { asObject, asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

function flag(b) { return statusBadge(b ? 'ENABLED' : 'OFF'); }

function statCards(d) {
  const sync = asObject(d.sync);
  const rows = [
    ['Persistence mode', dash(asObject(d.persistence).mode)],
    ['Credential provider', flag(asObject(d.credentials).providerActive)],
    ['Durable worker', flag(asObject(d.worker).enabled)],
    ['Inbound webhook', flag(asObject(d.webhook).enabled)],
    ['Real OTA HTTP', flag(sync.httpEnabled)],
    ['Real sync channels', dash((sync.realChannels || []).join(', '))],
    ['Live HTTP channels', dash((sync.httpChannels || []).join(', ') || '—')],
    ['Mapped room types', dash(asObject(d.mappings).count)]
  ];
  return card(sectionTitle('Subsystem status')
    + '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">'
    + rows.map(([k, v]) => `<div class="flex items-center justify-between border-b border-slate-100 py-1.5"><span class="text-sm text-slate">${k}</span><span class="text-sm font-medium">${v}</span></div>`).join('')
    + '</div>');
}

function channelsCard(d) {
  const channels = asArray(d.channels);
  const queue = asObject(d.queue);
  return card(sectionTitle('Channels & queue')
    + (channels.length ? table([
      { key: 'channel', label: 'Channel', render: (x) => dash(x.channel) },
      { key: 'internal', label: 'Type', render: (x) => statusBadge(x.internal ? 'INTERNAL' : 'OTA') },
      { key: 'commissionPct', label: 'Commission %', render: (x) => dash(x.commissionPct) }
    ], channels, { empty: 'No channels registered' })
      : infoBanner('No channels registered yet.', 'hub'))
    + `<p class="mt-3 text-xs text-slate">Queue size: <b>${dash(queue.size)}</b> · Dead-letter: <b>${dash(queue.deadLetter)}</b> · Bookings tracked: <b>${dash(d.bookings)}</b></p>`);
}

export function ControlView({ services, session }) {
  const canSync = can(session.getPrincipal(), 'channel.sync.run');

  function load(outlet) {
    const el = outlet.querySelector('#ctl-body');
    el.innerHTML = loading();
    services.channel.control().then((res) => {
      const d = asObject(res);
      el.innerHTML = `<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">${statCards(d)}${channelsCard(d)}</div>`;
    }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Control center unavailable'); });
  }

  return {
    render(outlet) {
      const actions = canSync
        ? `${btn('Sync rates', { action: 'ctl-rates', variant: 'ghost', icon: 'sell' })}${btn('Sync inventory', { action: 'ctl-inv', variant: 'ghost', icon: 'inventory' })}${btn('Sync bookings', { action: 'ctl-book', icon: 'sync' })}${btn('Refresh', { action: 'ctl-refresh', variant: 'ghost', icon: 'refresh' })}`
        : `${btn('Refresh', { action: 'ctl-refresh', variant: 'ghost', icon: 'refresh' })}`;
      outlet.innerHTML = pageHeader('Control Center', 'Channel Manager & OTA operational status', actions)
        + (canSync ? '' : infoBanner('You have read-only access to the control center.', 'lock'))
        + '<div id="ctl-body"></div>';
      load(outlet);
      const run = async (fn, label) => { try { await fn({}); toast(label + ' triggered', 'success'); load(outlet); } catch (e) { toast((e && e.message) || (label + ' failed'), 'error'); } };
      on(outlet, '[data-action="ctl-rates"]', 'click', () => run(services.channel.syncRates, 'Rate sync'));
      on(outlet, '[data-action="ctl-inv"]', 'click', () => run(services.channel.syncInventory, 'Inventory sync'));
      on(outlet, '[data-action="ctl-book"]', 'click', () => run(services.channel.syncBookings, 'Booking sync'));
      on(outlet, '[data-action="ctl-refresh"]', 'click', () => load(outlet));
    }
  };
}
