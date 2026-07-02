// Reservation Groups - create a group, look one up by id, view its rooming list,
// add rooms, and cancel/check-in all. Backed by /api/pms/reservation-groups.
import { pageHeader, card, sectionTitle, table, btn, field, textareaField, definitionList, statusBadge, infoBanner, loading, emptyState } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, titleCase } from '../../utils/format.js';
import { asObject, asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

export function GroupsView({ services, session }) {
  const canWrite = can(session.getPrincipal(), 'reservation.group.write');

  async function loadGroup(outlet, id) {
    const el = outlet.querySelector('#grp-detail');
    el.innerHTML = loading();
    try {
      const g = asObject(await services.groups.byId(id));
      if (!g || !(g.id || g.group_id)) { el.innerHTML = emptyState('No group found for that id', 'group_work'); return; }
      let rooming = [];
      try { rooming = asArray(await services.groups.roomingList(id)); } catch (_) { /* tolerate */ }
      const gid = g.id || g.group_id;
      const actions = canWrite ? [
        btn('Add room', { action: 'grp-addroom', id: gid, variant: 'ghost', icon: 'add' }),
        btn('Check-in all', { action: 'grp-checkin', id: gid, variant: 'ghost', icon: 'login' }),
        btn('Cancel all', { action: 'grp-cancel', id: gid, variant: 'danger', icon: 'block' })
      ].join('') : '';
      el.innerHTML = card(sectionTitle(dash(g.name || 'Group ' + gid), actions) + definitionList([
        ['Status', statusBadge(g.status)],
        ['Name', dash(g.name)],
        ['Rooms', dash(g.rooms_count != null ? g.rooms_count : rooming.length)],
        ['Holder', dash(g.holder_name || g.contact_name)]
      ])) + card(sectionTitle('Rooming List') + table([
        { key: 'reservation_number', label: 'Reservation', render: (r) => dash(r.reservation_number) },
        { key: 'guest_name', label: 'Guest', render: (r) => dash(r.guest_name || `${r.first_name || ''} ${r.last_name || ''}`.trim()) },
        { key: 'room_type_code', label: 'Room type', render: (r) => dash(r.room_type_code) },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }
      ], rooming, { empty: 'No rooms in this group yet' }), 'mt-5');
    } catch (e) { el.innerHTML = emptyState((e && e.message) || 'Group not found', 'group_work'); }
  }

  function openCreate(outlet) {
    const el = outlet.querySelector('#grp-detail');
    el.innerHTML = card(sectionTitle('New Reservation Group') + `<form id="gcform" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${field({ name: 'name', label: 'Group name', required: true })}
      ${field({ name: 'holder_name', label: 'Holder / contact' })}
      ${textareaField({ name: 'notes', label: 'Notes' })}
      </form><div class="flex justify-end gap-2 mt-4">${btn('Create group', { action: 'grp-create-go', icon: 'group_add' })}</div>`);
    on(el, '[data-action="grp-create-go"]', 'click', async () => {
      const d = Object.fromEntries(new FormData(el.querySelector('#gcform')).entries());
      if (!d.name) { toast('Group name required', 'error'); return; }
      try { const r = asObject(await services.groups.create(d)); const id = r.id || r.group_id; toast('Group created', 'success'); if (id) loadGroup(outlet, id); }
      catch (e) { toast((e && e.message) || 'Create failed', 'error'); }
    });
  }

  return {
    render(outlet) {
      const actions = canWrite ? btn('New Group', { action: 'grp-new', icon: 'group_add' }) : '';
      outlet.innerHTML = pageHeader('Reservation Groups', 'Block bookings, rooming lists & group actions', actions)
        + card(`<form id="grp-look" class="flex flex-wrap items-end gap-3">
            ${field({ name: 'gid', label: 'Group id', placeholder: 'Paste a group id' })}
            <div>${btn('Open', { action: 'grp-find', icon: 'search' })}</div></form>`, 'mb-5')
        + `<div id="grp-detail">${infoBanner('Open a group by id, or create a new one.')}</div>`;
      on(outlet, '[data-action="grp-find"]', 'click', (e) => { e.preventDefault(); const id = (outlet.querySelector('[name="gid"]') || {}).value; if (id) loadGroup(outlet, id); });
      on(outlet, '#grp-look', 'submit', (e) => { e.preventDefault(); const id = (outlet.querySelector('[name="gid"]') || {}).value; if (id) loadGroup(outlet, id); });
      on(outlet, '[data-action="grp-new"]', 'click', () => openCreate(outlet));
      on(outlet, '[data-action="grp-addroom"]', 'click', async (e, t) => {
        const rid = prompt('Reservation id to add to the group:'); if (!rid) return;
        try { await services.groups.addRoom(t.getAttribute('data-id'), rid); toast('Room added', 'success'); loadGroup(outlet, t.getAttribute('data-id')); }
        catch (err) { toast((err && err.message) || 'Add failed', 'error'); }
      });
      on(outlet, '[data-action="grp-checkin"]', 'click', async (e, t) => {
        try { await services.groups.checkinAll(t.getAttribute('data-id')); toast('Group checked in', 'success'); loadGroup(outlet, t.getAttribute('data-id')); }
        catch (err) { toast((err && err.message) || 'Check-in failed', 'error'); }
      });
      on(outlet, '[data-action="grp-cancel"]', 'click', async (e, t) => {
        const reason = prompt('Cancellation reason:') || '';
        try { await services.groups.cancelAll(t.getAttribute('data-id'), reason, false); toast('Group cancelled', 'success'); loadGroup(outlet, t.getAttribute('data-id')); }
        catch (err) { toast((err && err.message) || 'Cancel failed', 'error'); }
      });
    }
  };
}
