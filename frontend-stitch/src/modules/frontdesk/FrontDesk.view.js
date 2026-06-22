// Front Desk - reservations + check-in/out + stay timeline.
import { pageHeader, table, statusBadge, btn, card } from '../../components/ui.js';
import { loadInto } from '../../hooks/useApi.js';
import { on, esc } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';
import { date } from '../../utils/format.js';

export function FrontDeskView({ services }) {
  function load(outlet) {
    loadInto(outlet.querySelector('#fd-body'), () => services.frontdesk.stays({}), (rows) => card(table([
      { key: 'reservationId', label: 'Reservation' },
      { key: 'roomId', label: 'Room' },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      { key: 'checkInAt', label: 'Checked In', render: (r) => date(r.checkInAt) },
      { label: 'Actions', render: (r) => `${btn('Check-out', { action: 'checkout', variant: 'ghost' })}`.replace('data-action="checkout"', `data-action="checkout" data-id="${esc(r.reservationId)}"`) }
    ], Array.isArray(rows) ? rows : (rows && rows.result) || [], { empty: 'No active stays' })));
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Front Desk', 'Arrivals, in-house guests & departures') + '<div id="fd-body"></div>';
      load(outlet);
      on(outlet, '[data-action="checkout"]', 'click', async (e, t) => {
        try { await services.frontdesk.checkOut(t.getAttribute('data-id')); toast('Checked out', 'success'); load(outlet); }
        catch (err) { toast((err && err.message) || 'Check-out failed', 'error'); }
      });
    }
  };
}
