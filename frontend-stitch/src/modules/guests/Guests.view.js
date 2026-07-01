// Guests - searchable directory with profile drawer, create, and blacklist
// toggle. Backed by /api/pms/guests.
import { pageHeader, card, table, statusBadge, btn, field, selectField, textareaField, toolbar, modal, drawer, definitionList, loading, errorState } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, titleCase } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const GUEST_TYPES = ['INDIVIDUAL', 'CORPORATE', 'TRAVEL_AGENT', 'DMC', 'TOUR_ORGANIZER'];

export function GuestsView({ services, session }) {
  const canWrite = can(session.getPrincipal(), 'pms.guest.write');

  function load(outlet) {
    const body = outlet.querySelector('#g-body');
    const q = (outlet.querySelector('[name="q"]') || {}).value || undefined;
    const guest_type = (outlet.querySelector('[name="gtype"]') || {}).value || undefined;
    body.innerHTML = loading();
    services.guests.list({ q, guest_type }).then((res) => {
      body.innerHTML = card(table([
        { key: 'name', label: 'Name', render: (r) => `<button data-gid="${r.id}" class="text-primary font-medium hover:underline">${dash(`${r.first_name || ''} ${r.last_name || ''}`.trim())}</button>` },
        { key: 'guest_type', label: 'Type', render: (r) => titleCase(r.guest_type) },
        { key: 'organization_name', label: 'Organization', render: (r) => dash(r.organization_name) },
        { key: 'email', label: 'Email', render: (r) => dash(r.email) },
        { key: 'mobile', label: 'Mobile', render: (r) => dash(r.mobile) },
        { key: 'blacklisted_flag', label: 'Flags', render: (r) => (r.blacklisted_flag ? statusBadge('BLOCKED') : (r.vip_flag ? statusBadge('READY') : '—')) }
      ], asArray(res), { empty: 'No guests match' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load guests'); });
  }

  function openDetail(outlet, id) {
    openOverlay(drawer({ id: 'g', title: 'Guest Profile', body: `<div id="g-detail">${loading()}</div>` }), async (root) => {
      const el = root.querySelector('#g-detail');
      let g;
      try { g = asObject(await services.guests.byId(id)); } catch (e) { el.innerHTML = `<p class="text-error text-sm">${(e && e.message) || 'Failed'}</p>`; return; }
      el.innerHTML = definitionList([
        ['Name', dash(`${g.first_name || ''} ${g.last_name || ''}`.trim())],
        ['Type', titleCase(g.guest_type)],
        ['Organization', dash(g.organization_name)],
        ['Email', dash(g.email)], ['Mobile', dash(g.mobile)],
        ['Nationality', dash(g.nationality)], ['Passport', dash(g.passport_number)],
        ['VIP', g.vip_flag ? 'Yes' : 'No'], ['Blacklisted', g.blacklisted_flag ? 'Yes' : 'No'],
        ['Notes', dash(g.notes)]
      ]) + (canWrite ? `<div class="mt-6">${btn(g.blacklisted_flag ? 'Remove from blacklist' : 'Blacklist guest', { action: 'g-bl', variant: g.blacklisted_flag ? 'ghost' : 'danger', icon: 'block' })}</div>` : '');
      on(el, '[data-action="g-bl"]', 'click', async () => {
        try { await services.guests.blacklist(id, !g.blacklisted_flag); toast('Updated', 'success'); closeOverlay(); load(outlet); }
        catch (e) { toast((e && e.message) || 'Failed', 'error'); }
      });
    });
  }

  function openCreate(outlet) {
    openOverlay(modal({ id: 'gnew', title: 'New Guest', size: 'max-w-xl', body: `<form id="gform" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${selectField({ name: 'guest_type', label: 'Type', value: 'INDIVIDUAL', placeholder: '', options: GUEST_TYPES.map((t) => ({ value: t, label: titleCase(t) })) })}
      ${field({ name: 'first_name', label: 'First name', required: true })}
      ${field({ name: 'last_name', label: 'Last name' })}
      ${field({ name: 'organization_name', label: 'Organization' })}
      ${field({ name: 'email', label: 'Email', type: 'email' })}
      ${field({ name: 'mobile', label: 'Mobile' })}
      ${field({ name: 'nationality', label: 'Nationality' })}
      ${field({ name: 'passport_number', label: 'Passport' })}
    </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Create guest', { action: 'gnew-go', icon: 'person_add' })}` }), (root) => {
      on(root, '[data-action="gnew-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(root.querySelector('#gform')).entries());
        if (!d.first_name) { toast('First name required', 'error'); return; }
        try { await services.guests.create(d); toast('Guest created', 'success'); closeOverlay(); load(outlet); }
        catch (e) { toast((e && e.message) || 'Create failed', 'error'); }
      });
    });
  }

  return {
    render(outlet) {
      const actions = canWrite ? btn('New Guest', { action: 'g-new', icon: 'person_add' }) : '';
      outlet.innerHTML = pageHeader('Guests', 'Guest & company directory', actions)
        + `<form id="g-filters">${toolbar(`
            ${field({ name: 'q', label: 'Search', placeholder: 'Name, email, org…' })}
            ${selectField({ name: 'gtype', label: 'Type', placeholder: 'All', options: GUEST_TYPES.map((t) => ({ value: t, label: titleCase(t) })) })}
            <div>${btn('Search', { action: 'g-apply', icon: 'search' })}</div>`)}</form>
          <div id="g-body"></div>`;
      load(outlet);
      on(outlet, '[data-action="g-apply"]', 'click', (e) => { e.preventDefault(); load(outlet); });
      on(outlet, '#g-filters', 'submit', (e) => { e.preventDefault(); load(outlet); });
      on(outlet, '[data-gid]', 'click', (e, t) => openDetail(outlet, t.getAttribute('data-gid')));
      on(outlet, '[data-action="g-new"]', 'click', () => openCreate(outlet));
    }
  };
}
