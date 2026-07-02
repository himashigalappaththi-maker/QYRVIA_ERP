// Channel Manager - OTA mapping/sync status with manual sync triggers. Backed by
// /api/channel/status + /sync/* + /bookings/*.
import { pageHeader, card, table, statusBadge, btn, sectionTitle, loading, errorState, infoBanner } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, datetime } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

export function ChannelView({ services, session }) {
  const canSync = can(session.getPrincipal(), 'channel.sync.run');

  function load(outlet) {
    const el = outlet.querySelector('#ch-body');
    el.innerHTML = loading();
    services.channel.status().then((res) => {
      const data = asObject(res);
      const mappings = asArray(data.mappings || res);
      el.innerHTML = card(sectionTitle('Channel status')
        + (mappings.length ? table([
          { key: 'channel', label: 'Channel', render: (x) => dash(x.channel || x.name) },
          { key: 'status', label: 'Status', render: (x) => statusBadge(x.status || (x.connected ? 'OPEN' : 'CLOSED')) },
          { key: 'last_sync_at', label: 'Last sync', render: (x) => datetime(x.last_sync_at || x.lastSyncAt) }
        ], mappings, { empty: 'No channels mapped' })
          : `<pre class="text-xs text-slate overflow-x-auto">${JSON.stringify(data, null, 2)}</pre>`));
    }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Channel status unavailable'); });
  }

  return {
    render(outlet) {
      const actions = canSync ? `${btn('Sync rates', { action: 'ch-rates', variant: 'ghost', icon: 'sell' })}${btn('Sync inventory', { action: 'ch-inv', variant: 'ghost', icon: 'inventory' })}${btn('Sync bookings', { action: 'ch-book', icon: 'sync' })}` : '';
      outlet.innerHTML = pageHeader('Channel Manager', 'OTA mappings & synchronization', actions)
        + (canSync ? '' : infoBanner('You have read-only access to channel status.', 'lock'))
        + '<div id="ch-body"></div>';
      load(outlet);
      const run = async (fn, label) => { try { await fn({}); toast(label + ' triggered', 'success'); load(outlet); } catch (e) { toast((e && e.message) || (label + ' failed'), 'error'); } };
      on(outlet, '[data-action="ch-rates"]', 'click', () => run(services.channel.syncRates, 'Rate sync'));
      on(outlet, '[data-action="ch-inv"]', 'click', () => run(services.channel.syncInventory, 'Inventory sync'));
      on(outlet, '[data-action="ch-book"]', 'click', () => run(services.channel.syncBookings, 'Booking sync'));
    }
  };
}
