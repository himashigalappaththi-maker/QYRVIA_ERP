// Shared reservation UI: reference loading, create modal, detail drawer, and the
// lifecycle actions (confirm / cancel / no-show / check-in / check-out). Used by
// both the Reservations and Front Desk modules. Every action maps to an existing
// /api/pms route; RBAC gating is passed in via `canWrite`.
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { modal, drawer, selectField, field, textareaField, btn, definitionList, statusBadge, infoBanner, loading } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { on } from '../../utils/dom.js';
import { date, dash, titleCase } from '../../utils/format.js';
import { buildReservationPayload, canConfirm, canCancel, canNoShow, canCheckIn, canCheckOut } from './logic.js';

export async function fetchRefs(services) {
  const [g, rt, rp, cp] = await Promise.all([
    services.guests.list({}).catch(() => []),
    services.rooms.roomTypes().catch(() => []),
    services.ratePlans.list().catch(() => []),
    services.childPolicies.list().catch(() => [])
  ]);
  return { guests: asArray(g), roomTypes: asArray(rt), ratePlans: asArray(rp), childPolicies: asArray(cp) };
}

const guestOpts = (gs) => gs.map((x) => ({ value: x.id, label: `${x.first_name || ''} ${x.last_name || ''}`.trim() + (x.organization_name ? ` (${x.organization_name})` : '') + ` · ${x.guest_type || ''}` }));
const rtOpts = (xs) => xs.map((x) => ({ value: x.id, label: `${x.code || ''} — ${x.name || ''}` }));
const codeOpts = (xs) => xs.map((x) => ({ value: x.id, label: `${x.code || ''} — ${x.name || ''}` }));

export function openCreateReservation({ services, refs, onDone }) {
  const today = new Date().toISOString().slice(0, 10);
  const noGuests = refs.guests.length === 0;
  const body = `${noGuests ? infoBanner('No guests exist yet. Create a guest in the Guests module first — a reservation needs a holder.', 'warning') : ''}
  <form id="resv-form" class="space-y-4">
    ${selectField({ name: 'reservation_type', label: 'Type', value: 'INDIVIDUAL', placeholder: '', options: [
      { value: 'INDIVIDUAL', label: 'Individual' }, { value: 'CORPORATE', label: 'Corporate' },
      { value: 'AGENT', label: 'Travel Agent' }, { value: 'GROUP', label: 'Group' },
      { value: 'DMC', label: 'DMC' }, { value: 'TOUR', label: 'Tour' }] })}
    ${selectField({ name: 'holder_guest_id', label: 'Holder (guest / company / agent)', required: true, options: guestOpts(refs.guests) })}
    ${selectField({ name: 'primary_adult_guest_id', label: 'Primary adult', required: true, options: guestOpts(refs.guests) })}
    ${selectField({ name: 'room_type_id', label: 'Room type', required: true, options: rtOpts(refs.roomTypes) })}
    ${selectField({ name: 'rate_plan_id', label: 'Rate plan', options: codeOpts(refs.ratePlans) })}
    <div class="grid grid-cols-2 gap-3">
      ${field({ name: 'arrival_date', label: 'Arrival', type: 'date', value: today, required: true })}
      ${field({ name: 'departure_date', label: 'Departure', type: 'date', required: true })}
    </div>
    <div class="grid grid-cols-3 gap-3">
      ${field({ name: 'adults', label: 'Adults', type: 'number', value: '2', extra: 'min="1"' })}
      ${field({ name: 'children', label: 'Children', type: 'number', value: '0', extra: 'min="0"' })}
      ${field({ name: 'rooms_count', label: 'Rooms', type: 'number', value: '1', extra: 'min="1"' })}
    </div>
    ${selectField({ name: 'child_policy_id', label: 'Child policy (if children)', options: codeOpts(refs.childPolicies) })}
    ${textareaField({ name: 'notes', label: 'Notes' })}
  </form>`;
  const footer = `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Create reservation', { action: 'resv-submit', icon: 'add' })}`;
  openOverlay(modal({ id: 'resv', title: 'New Reservation', body, footer, size: 'max-w-xl' }), (root) => {
    on(root, '[data-action="resv-submit"]', 'click', async () => {
      const form = root.querySelector('#resv-form');
      const data = Object.fromEntries(new FormData(form).entries());
      const built = buildReservationPayload(data);
      if (!built.ok) { toast(built.error, 'error'); return; }
      try {
        const res = asObject(await services.reservations.create(built.payload));
        toast('Reservation created: ' + (res.reservation_number || ''), 'success');
        closeOverlay();
        if (onDone) onDone();
      } catch (e) { toast((e && e.message) || 'Create failed', 'error'); }
    });
  });
}

function actionButtons(res, canWrite) {
  if (!canWrite) return '';
  const b = [];
  if (canConfirm(res)) b.push(btn('Confirm', { action: 'rx-confirm', variant: 'primary', icon: 'check' }));
  if (canCheckIn(res)) b.push(btn('Check-in', { action: 'rx-checkin', variant: 'primary', icon: 'login' }));
  if (canCheckOut(res)) b.push(btn('Check-out', { action: 'rx-checkout', variant: 'secondary', icon: 'logout' }));
  if (canNoShow(res)) b.push(btn('No-show', { action: 'rx-noshow', variant: 'ghost', icon: 'person_off' }));
  if (canCancel(res)) b.push(btn('Cancel', { action: 'rx-cancel', variant: 'danger', icon: 'cancel' }));
  return b.join('');
}

export function openReservationDetail({ services, number, canWrite, onChanged }) {
  openOverlay(drawer({ id: 'rdetail', title: 'Reservation ' + number, body: `<div id="rdetail-body">${loading()}</div>` }), async (root) => {
    const bodyEl = root.querySelector('#rdetail-body');
    let res;
    try { res = asObject(await services.reservations.byNumber(number)); }
    catch (e) { bodyEl.innerHTML = `<p class="text-error text-sm">${(e && e.message) || 'Failed to load'}</p>`; return; }
    if (!res || !res.id) { bodyEl.innerHTML = '<p class="text-slate text-sm">Reservation not found.</p>'; return; }

    bodyEl.innerHTML = definitionList([
      ['Number', `<span class="font-medium">${res.reservation_number || dash()}</span>`],
      ['Status', statusBadge(res.status)],
      ['Type', dash(titleCase(res.reservation_type))],
      ['Arrival', date(res.arrival_date)],
      ['Departure', date(res.departure_date)],
      ['Nights', dash(res.nights)],
      ['Adults / Children', `${dash(res.adults)} / ${dash(res.children)}`],
      ['Rooms', dash(res.rooms_count)],
      ['Assigned room', dash(res.assigned_room_id)],
      ['Checked in', date(res.checked_in_at)],
      ['Checked out', date(res.checked_out_at)],
      ['Notes', dash(res.notes)]
    ]) + `<div class="flex flex-wrap gap-2 mt-6">${actionButtons(res, canWrite)}</div>`;

    const refresh = () => { closeOverlay(); if (onChanged) onChanged(); };
    const wrap = (fn) => async () => { try { await fn(); toast('Done', 'success'); refresh(); } catch (e) { toast((e && e.message) || 'Action failed', 'error'); } };

    on(bodyEl, '[data-action="rx-confirm"]', 'click', wrap(() => services.reservations.confirm(res.id)));
    on(bodyEl, '[data-action="rx-noshow"]', 'click', wrap(() => services.reservations.noShow(res.id)));
    on(bodyEl, '[data-action="rx-cancel"]', 'click', wrap(async () => {
      const reason = prompt('Cancellation reason?') || undefined;
      return services.reservations.cancel(res.id, reason);
    }));
    on(bodyEl, '[data-action="rx-checkout"]', 'click', wrap(() => services.reservations.checkOut(res.id, false)));
    on(bodyEl, '[data-action="rx-checkin"]', 'click', () => openCheckIn({ services, res, onDone: refresh }));
  });
}

// Check-in modal: optionally pick a vacant room (assigned_room_id).
export function openCheckIn({ services, res, onDone }) {
  openOverlay(modal({ id: 'ci', title: 'Check-in ' + (res.reservation_number || ''), body: `<div id="ci-body">${loading()}</div>`,
    footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Confirm check-in', { action: 'ci-go', icon: 'login' })}` }), async (root) => {
    const bodyEl = root.querySelector('#ci-body');
    let rooms = [];
    try { rooms = asArray(await services.rooms.list({ active_only: true })); } catch (_) { /* optional */ }
    const vacant = rooms.filter((r) => ['VACANT_CLEAN', 'INSPECTED'].includes(String(r.status).toUpperCase()));
    bodyEl.innerHTML = `${infoBanner('Assigning a room is optional; the backend opens a folio automatically on check-in.', 'meeting_room')}
      ${selectField({ name: 'assigned_room_id', label: 'Assign room (vacant & clean)', options: vacant.map((r) => ({ value: r.id, label: `${r.room_number} · ${r.room_type_code || ''} · ${String(r.status).replace(/_/g, ' ')}` })) })}`;
    on(root, '[data-action="ci-go"]', 'click', async () => {
      const sel = root.querySelector('[name="assigned_room_id"]');
      try {
        await services.reservations.checkIn(res.id, sel && sel.value ? sel.value : null);
        toast('Checked in', 'success'); closeOverlay(); if (onDone) onDone();
      } catch (e) { toast((e && e.message) || 'Check-in failed', 'error'); }
    });
  });
}
