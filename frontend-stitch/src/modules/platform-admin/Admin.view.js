// Platform Admin - observability (metrics + logs), audit stream, integrations,
// enterprise control (properties / analytics / config) and user provisioning.
// Backed by /api/platform/* (returns { result }) and /api/auth/register.
import { pageHeader, card, table, statusBadge, btn, tabs, field, selectField, kpiCard, modal, sectionTitle, definitionList, loading, errorState, emptyState, infoBanner } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { datetime, dash, titleCase, num } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

export function AdminView({ services, session }) {
  const principal = session.getPrincipal();
  const canRegister = can(principal, 'auth.user.create');
  let active = 'observability';

  const render = {
    observability(el) {
      el.innerHTML = '<div id="ad-metrics" class="mb-6"></div><div id="ad-logs"></div>';
      services.platform.metrics().then((r) => {
        const snap = asObject(r);
        const counters = snap.counters || snap;
        const rows = Object.entries(counters).filter(([, v]) => typeof v !== 'object');
        el.querySelector('#ad-metrics').innerHTML = rows.length
          ? `<div class="grid grid-cols-2 md:grid-cols-4 gap-4">${rows.slice(0, 8).map(([k, v]) => kpiCard({ label: titleCase(k), value: num(v), icon: 'monitoring' })).join('')}</div>`
          : card(emptyState('No metrics yet', 'monitoring'));
      }).catch((e) => { el.querySelector('#ad-metrics').innerHTML = errorState((e && e.message) || 'Metrics unavailable'); });
      services.platform.logs({}).then((r) => {
        const rows = asArray(r);
        el.querySelector('#ad-logs').innerHTML = card(sectionTitle('Recent logs') + table([
          { key: 'level', label: 'Level', render: (x) => statusBadge(x.level) },
          { key: 'module', label: 'Module', render: (x) => dash(x.module) },
          { key: 'message', label: 'Message', render: (x) => dash(x.message || x.msg) },
          { key: 'at', label: 'When', render: (x) => datetime(x.at || x.time) }
        ], rows.slice(-30).reverse(), { empty: 'No logs' }));
      }).catch(() => { el.querySelector('#ad-logs').innerHTML = card(emptyState('Logs unavailable', 'info')); });
    },
    audit(el) {
      el.innerHTML = loading();
      services.platform.audit({}).then((r) => {
        const rows = asArray(r);
        el.innerHTML = card(sectionTitle('Immutable audit stream') + table([
          { key: 'type', label: 'Event', render: (x) => dash(x.type || x.event_type) },
          { key: 'propertyId', label: 'Property', render: (x) => dash(x.propertyId || x.property_id) },
          { key: 'userId', label: 'User', render: (x) => dash(x.userId || x.user_id) },
          { key: 'at', label: 'When', render: (x) => datetime(x.at || x.created_at) }
        ], rows.slice(-50).reverse(), { empty: 'No audit entries' }));
      }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Audit unavailable'); });
    },
    integrations(el) {
      el.innerHTML = loading();
      services.platform.integrations().then((r) => {
        const rows = asArray(r);
        el.innerHTML = card(sectionTitle('Integrations') + table([
          { key: 'id', label: 'System', render: (x) => dash(x.id || x.name) },
          { key: 'type', label: 'Type', render: (x) => dash(x.type) },
          { key: 'enabled', label: 'Status', render: (x) => statusBadge((x.enabled ?? x.connected) ? 'OPEN' : 'CLOSED') }
        ], rows, { empty: 'No integrations registered' }));
      }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Integrations unavailable'); });
    },
    enterprise(el) {
      el.innerHTML = '<div id="ad-props" class="mb-6"></div><div class="grid grid-cols-1 lg:grid-cols-2 gap-6"><div id="ad-analytics"></div><div id="ad-config"></div></div>';
      services.platform.properties().then((r) => {
        el.querySelector('#ad-props').innerHTML = card(sectionTitle('Properties') + table([
          { key: 'propertyId', label: 'Property', render: (x) => dash(x.propertyId || x.id) },
          { key: 'name', label: 'Name', render: (x) => dash(x.name) },
          { key: 'timezone', label: 'Timezone', render: (x) => dash(x.timezone || x.tz) }
        ], asArray(r), { empty: 'No properties' }));
      }).catch((e) => { el.querySelector('#ad-props').innerHTML = errorState((e && e.message) || 'Properties unavailable'); });
      services.platform.analytics().then((r) => {
        const o = asObject(r);
        const pairs = Object.entries(o).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [titleCase(k), String(v)]);
        el.querySelector('#ad-analytics').innerHTML = card(sectionTitle('Analytics') + (pairs.length ? definitionList(pairs) : emptyState('No analytics', 'analytics')));
      }).catch(() => { el.querySelector('#ad-analytics').innerHTML = ''; });
      services.platform.config().then((r) => {
        const o = asObject(r);
        const pairs = Object.entries(o).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [titleCase(k), String(v)]);
        el.querySelector('#ad-config').innerHTML = card(sectionTitle('Global config') + (pairs.length ? definitionList(pairs) : emptyState('No config', 'settings')));
      }).catch(() => { el.querySelector('#ad-config').innerHTML = ''; });
    },
    users(el) {
      el.innerHTML = card(
        infoBanner('The backend exposes user creation (auth.user.create) but no user list; created users appear in the audit stream.', 'group_add')
        + (canRegister ? `<form id="ureg" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${field({ name: 'username', label: 'Username', required: true })}
            ${field({ name: 'password', label: 'Temp password', type: 'password', required: true })}
            ${field({ name: 'full_name', label: 'Full name' })}
            ${field({ name: 'email', label: 'Email', type: 'email' })}
            ${field({ name: 'role_code', label: 'Role code (e.g. front_office_manager)' })}
            <div class="sm:col-span-2">${btn('Create user', { action: 'ureg-go', icon: 'person_add' })}</div>
          </form>` : emptyState('You do not have permission to create users.', 'lock')));
    }
  };

  function renderActive(outlet) {
    outlet.querySelector('#ad-tabs').innerHTML = tabs([
      { id: 'observability', label: 'Observability' },
      { id: 'audit', label: 'Audit' },
      { id: 'integrations', label: 'Integrations' },
      { id: 'enterprise', label: 'Enterprise' },
      { id: 'users', label: 'Users' }
    ], active);
    (render[active] || render.observability)(outlet.querySelector('#ad-body'));
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Platform Admin', 'Observability, integrations & enterprise control')
        + '<div id="ad-tabs"></div><div id="ad-body"></div>';
      renderActive(outlet);
      on(outlet, '[data-tab]', 'click', (e, t) => { active = t.getAttribute('data-tab'); renderActive(outlet); });
      on(outlet, '[data-action="ureg-go"]', 'click', async (e) => {       // bound once (delegated)
        e.preventDefault();
        const form = outlet.querySelector('#ureg'); if (!form) return;
        const d = Object.fromEntries(new FormData(form).entries());
        if (!d.username || !d.password) { toast('Username and password required', 'error'); return; }
        const body = { username: d.username, password: d.password, full_name: d.full_name || undefined, email: d.email || undefined };
        if (d.role_code) body.role_codes = [d.role_code];
        try { await services.auth.register(body); toast('User created', 'success'); form.reset(); }
        catch (err) { toast((err && err.message) || 'Create failed', 'error'); }
      });
    }
  };
}
