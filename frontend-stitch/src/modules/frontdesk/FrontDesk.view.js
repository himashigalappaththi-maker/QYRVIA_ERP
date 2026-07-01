// Front Desk - the operational cockpit: today's Arrivals, Departures and the
// In-House list, derived from /api/pms/reservations, with one-click check-in /
// check-out and a detail drawer. No backend calls beyond existing pms routes.
import { pageHeader, card, table, statusBadge, btn, tabs, loading, errorState, emptyState } from '../../components/ui.js';
import { on } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';
import { date, isoDay } from '../../utils/format.js';
import { asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';
import { deriveArrivals, deriveDepartures, deriveInHouse } from './logic.js';
import { openReservationDetail, openCheckIn } from './shared.js';

export function FrontDeskView({ services, session }) {
  const principal = session.getPrincipal();
  const canWrite = can(principal, 'pms.reservation.write');
  const today = isoDay(0);
  let active = 'arrivals';
  let rows = [];

  function rowsFor(tab) {
    if (tab === 'arrivals') return deriveArrivals(rows, today);
    if (tab === 'departures') return deriveDepartures(rows, today);
    return deriveInHouse(rows);
  }

  function actionCell(r) {
    const detail = `<button data-num="${r.reservation_number}" class="text-primary text-sm hover:underline">Open</button>`;
    if (!canWrite) return detail;
    let act = '';
    if (active === 'arrivals') act = btn('Check-in', { action: 'fd-checkin', id: r.id, variant: 'primary', icon: 'login' });
    else if (active === 'departures' || active === 'inhouse') act = btn('Check-out', { action: 'fd-checkout', id: r.id, variant: 'secondary', icon: 'logout' });
    return `<div class="flex items-center gap-3">${act}${detail}</div>`;
  }

  function renderBody(outlet) {
    const list = rowsFor(active);
    const body = outlet.querySelector('#fd-body');
    if (!list.length) { body.innerHTML = card(emptyState(active === 'arrivals' ? 'No arrivals due' : active === 'departures' ? 'No departures due' : 'No in-house guests', 'hotel')); return; }
    body.innerHTML = card(table([
      { key: 'reservation_number', label: 'Number' },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      { key: 'arrival_date', label: 'Arrival', render: (r) => date(r.arrival_date) },
      { key: 'departure_date', label: 'Departure', render: (r) => date(r.departure_date) },
      { key: 'assigned_room_id', label: 'Room', render: (r) => r.assigned_room_id || '—' },
      { label: 'Actions', render: actionCell }
    ], list, { empty: 'None' }));
  }

  function renderTabs(outlet) {
    outlet.querySelector('#fd-tabs').innerHTML = tabs([
      { id: 'arrivals', label: 'Arrivals', count: deriveArrivals(rows, today).length },
      { id: 'departures', label: 'Departures', count: deriveDepartures(rows, today).length },
      { id: 'inhouse', label: 'In-House', count: deriveInHouse(rows).length }
    ], active);
  }

  function load(outlet) {
    outlet.querySelector('#fd-body').innerHTML = loading();
    // Pull a window around today for arrivals plus all in-house; the list route
    // filters by arrival_date, so we fetch broadly and derive client-side.
    services.reservations.list({}).then((res) => {
      rows = asArray(res);
      renderTabs(outlet); renderBody(outlet);
    }).catch((e) => { outlet.querySelector('#fd-body').innerHTML = errorState((e && e.message) || 'Failed to load'); });
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Front Desk', 'Arrivals, in-house guests & departures — ' + today)
        + '<div id="fd-tabs"></div><div id="fd-body"></div>';
      load(outlet);

      on(outlet, '[data-tab]', 'click', (e, t) => { active = t.getAttribute('data-tab'); renderTabs(outlet); renderBody(outlet); });
      on(outlet, '[data-num]', 'click', (e, t) => openReservationDetail({ services, number: t.getAttribute('data-num'), canWrite, onChanged: () => load(outlet) }));
      on(outlet, '[data-action="fd-checkin"]', 'click', (e, t) => {
        const r = rows.find((x) => x.id === t.getAttribute('data-id'));
        if (r) openCheckIn({ services, res: r, onDone: () => load(outlet) });
      });
      on(outlet, '[data-action="fd-checkout"]', 'click', async (e, t) => {
        try { await services.reservations.checkOut(t.getAttribute('data-id'), false); /* success */ load(outlet); }
        catch (err) {
          const msg = (err && err.message) || 'Check-out failed';
          // folio_has_balance -> offer force close
          if (/balance/i.test(msg) && confirm('Folio has an outstanding balance. Force checkout & close folio?')) {
            try { await services.reservations.checkOut(t.getAttribute('data-id'), true); load(outlet); }
            catch (e2) { toast((e2 && e2.message) || msg, 'error'); }
          } else { toast(msg, 'error'); }
        }
      });
    }
  };
}
