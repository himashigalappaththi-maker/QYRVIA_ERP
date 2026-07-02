// Rooms - inventory board with status changes + activate/deactivate, plus Room
// Types and Features tabs. Backed by /api/pms/rooms, /room-types, /room-features.
import { pageHeader, card, table, statusBadge, btn, tabs, field, selectField, modal, loading, errorState } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash } from '../../utils/format.js';
import { asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const ROOM_STATUSES = ['VACANT_CLEAN', 'VACANT_DIRTY', 'OCCUPIED', 'INSPECTED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE', 'BLOCKED'];

export function RoomsView({ services, session }) {
  const principal = session.getPrincipal();
  const canWrite = can(principal, 'pms.room.write');
  let active = 'rooms';

  const sections = {
    rooms(el) {
      el.innerHTML = loading();
      services.rooms.list({}).then((res) => {
        el.innerHTML = card(table([
          { key: 'room_number', label: 'Room' },
          { key: 'room_type_code', label: 'Type', render: (r) => dash(r.room_type_code) },
          { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
          { key: 'active', label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') },
          { label: 'Actions', render: (r) => (canWrite ? `<div class="flex gap-2">${btn('Status', { action: 'rm-status', id: r.id, variant: 'ghost', icon: 'sync' })}${btn(r.active ? 'Deactivate' : 'Activate', { action: r.active ? 'rm-deact' : 'rm-act', id: r.id, variant: 'ghost' })}</div>` : '') }
        ], asArray(res), { empty: 'No rooms configured' }));
      }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Failed to load rooms'); });
    },
    types(el) {
      el.innerHTML = loading();
      services.rooms.roomTypes().then((res) => {
        el.innerHTML = card(table([
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' },
          { key: 'base_occupancy', label: 'Base occ' }, { key: 'max_adults', label: 'Max adults' }, { key: 'max_children', label: 'Max children' }
        ], asArray(res), { empty: 'No room types' }));
      }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Failed to load'); });
    },
    features(el) {
      el.innerHTML = loading();
      services.rooms.features().then((res) => {
        el.innerHTML = card(table([{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }], asArray(res), { empty: 'No features' }));
      }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Failed to load'); });
    }
  };

  function openStatus(outlet, id) {
    openOverlay(modal({ id: 'rms', title: 'Change Room Status', body: `<form id="rmsf">${selectField({ name: 'status', label: 'New status', required: true, options: ROOM_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })) })}</form>`,
      footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Apply', { action: 'rms-go', icon: 'sync' })}` }), (root) => {
      on(root, '[data-action="rms-go"]', 'click', async () => {
        const s = (root.querySelector('[name="status"]') || {}).value;
        if (!s) { toast('Select a status', 'error'); return; }
        try { await services.rooms.setStatus(id, s); toast('Status updated', 'success'); closeOverlay(); sections.rooms(outlet.querySelector('#rm-body')); }
        catch (e) { toast((e && e.message) || 'Failed', 'error'); }
      });
    });
  }

  function renderActive(outlet) {
    outlet.querySelector('#rm-tabs').innerHTML = tabs([
      { id: 'rooms', label: 'Rooms' }, { id: 'types', label: 'Room Types' }, { id: 'features', label: 'Features' }
    ], active);
    (sections[active] || sections.rooms)(outlet.querySelector('#rm-body'));
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Rooms', 'Room inventory, types & features')
        + '<div id="rm-tabs"></div><div id="rm-body"></div>';
      renderActive(outlet);
      on(outlet, '[data-tab]', 'click', (e, t) => { active = t.getAttribute('data-tab'); renderActive(outlet); });
      on(outlet, '[data-action="rm-status"]', 'click', (e, t) => openStatus(outlet, t.getAttribute('data-id')));
      on(outlet, '[data-action="rm-act"]', 'click', async (e, t) => { try { await services.rooms.activate(t.getAttribute('data-id')); toast('Activated', 'success'); sections.rooms(outlet.querySelector('#rm-body')); } catch (err) { toast((err && err.message) || 'Failed', 'error'); } });
      on(outlet, '[data-action="rm-deact"]', 'click', async (e, t) => { try { await services.rooms.deactivate(t.getAttribute('data-id')); toast('Deactivated', 'success'); sections.rooms(outlet.querySelector('#rm-body')); } catch (err) { toast((err && err.message) || 'Failed', 'error'); } });
    }
  };
}
