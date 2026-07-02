// Reservations - search/filter the booking book, create new reservations, open
// a detail drawer with the full lifecycle actions. Backed entirely by existing
// /api/pms/reservations routes.
import { pageHeader, card, table, statusBadge, btn, field, selectField, toolbar, loading, errorState } from '../../components/ui.js';
import { on } from '../../utils/dom.js';
import { date, titleCase, isoDay } from '../../utils/format.js';
import { asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';
import { fetchRefs, openCreateReservation, openReservationDetail } from '../frontdesk/shared.js';

const STATUSES = ['', 'INQUIRY', 'OPTION', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'];

export function ReservationsView({ services, session }) {
  const principal = session.getPrincipal();
  const canWrite = can(principal, 'pms.reservation.write');

  function filtersFromForm(root) {
    const g = (n) => { const el = root.querySelector(`[name="${n}"]`); return el && el.value ? el.value : undefined; };
    return { status: g('status'), date_from: g('date_from'), date_to: g('date_to') };
  }

  function load(root) {
    const body = root.querySelector('#resv-body');
    body.innerHTML = loading();
    services.reservations.list(filtersFromForm(root)).then((res) => {
      const rows = asArray(res);
      body.innerHTML = card(table([
        { key: 'reservation_number', label: 'Number', render: (r) => `<button data-num="${r.reservation_number}" class="text-primary font-medium hover:underline">${r.reservation_number || '—'}</button>` },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'reservation_type', label: 'Type', render: (r) => titleCase(r.reservation_type) },
        { key: 'arrival_date', label: 'Arrival', render: (r) => date(r.arrival_date) },
        { key: 'departure_date', label: 'Departure', render: (r) => date(r.departure_date) },
        { key: 'adults', label: 'Pax', render: (r) => `${r.adults || 0}+${r.children || 0}` },
        { key: 'rooms_count', label: 'Rooms' }
      ], rows, { empty: 'No reservations match these filters' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load reservations'); });
  }

  return {
    render(outlet) {
      const actions = canWrite ? btn('New Reservation', { action: 'new-resv', icon: 'add' }) : '';
      outlet.innerHTML = pageHeader('Reservations', 'Search and manage the booking book', actions) + `
        <form id="resv-filters">${toolbar(`
          ${selectField({ name: 'status', label: 'Status', placeholder: 'All statuses', options: STATUSES.filter(Boolean).map((s) => ({ value: s, label: titleCase(s) })) })}
          ${field({ name: 'date_from', label: 'Arrival from', type: 'date' })}
          ${field({ name: 'date_to', label: 'Arrival to', type: 'date' })}
          <div>${btn('Apply', { action: 'apply', icon: 'filter_list' })}</div>
        `)}</form>
        <div id="resv-body"></div>`;

      load(outlet);
      on(outlet, '[data-action="apply"]', 'click', (e) => { e.preventDefault(); load(outlet); });
      on(outlet, '#resv-filters', 'submit', (e) => { e.preventDefault(); load(outlet); });
      on(outlet, '[data-num]', 'click', (e, t) => openReservationDetail({ services, number: t.getAttribute('data-num'), canWrite, onChanged: () => load(outlet) }));
      on(outlet, '[data-action="new-resv"]', 'click', async () => {
        const refs = await fetchRefs(services);
        openCreateReservation({ services, refs, onDone: () => load(outlet) });
      });
    }
  };
}
