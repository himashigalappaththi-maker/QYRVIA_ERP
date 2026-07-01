// New Booking (Phase 26) - the QYRVIA reservation entry point. Create / update /
// cancel reservations through the Booking Engine (single orchestration layer):
// POST /api/booking/{create,update/:id,cancel/:id} -> BookingService -> PMS.
import { pageHeader, card, sectionTitle, field, selectField, btn, infoBanner, statusBadge } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'LKR', 'INR', 'AED'];

export function BookingView({ services, session }) {
  const canBook = can(session.getPrincipal(), 'pms.reservation.write');

  function readForm(root) {
    const get = (n) => { const el = root.querySelector(`[name="${n}"]`); return el ? String(el.value || '').trim() : ''; };
    const body = {
      channel: 'DIRECT', room_type_id: get('room_type_id'), guest_name: get('guest_name'),
      arrival: get('arrival'), departure: get('departure'),
      adults: Number(get('adults') || 0), children: Number(get('children') || 0),
      base_rate: Number(get('base_rate') || 0), currency: get('currency') || 'USD'
    };
    if (get('external_ref')) body.external_ref = get('external_ref');
    return body;
  }

  function successCard(r) {
    const res = (r && r.result) || {};
    const p = res.pricing || {};
    return card(sectionTitle('Booking ' + (res.action === 'cancel' ? 'cancelled' : res.action === 'update' ? 'updated' : 'confirmed'))
      + `<p class="text-sm">Reservation: <b>${res.reservation_id || '—'}</b> ${statusBadge(res.action === 'cancel' ? 'CANCELLED' : 'CONFIRMED')}</p>`
      + (p.total != null ? `<p class="mt-2 text-sm text-slate">Total: <b>${p.total} ${p.currency || ''}</b> (base ${p.base_rate} + tax ${p.taxes}${p.discounts ? ' − disc ' + p.discounts : ''})</p>` : ''));
  }
  function rejectCard(e) {
    const detail = e && e.data && e.data.detail ? ': ' + [].concat(e.data.detail).join(', ') : '';
    return card(sectionTitle('Booking rejected') + `<p class="text-sm text-rose-600">${(e && e.message) || 'failed'}${detail}</p>`);
  }

  function bookingForm(roomTypes) {
    return card(sectionTitle('Book a stay')
      + '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">'
      + selectField({ name: 'room_type_id', label: 'Room type', required: true, options: roomTypes.map((x) => ({ value: x.id, label: `${x.code || ''} ${x.name || x.id}`.trim() })) })
      + field({ name: 'guest_name', label: 'Guest name', required: true })
      + field({ name: 'arrival', label: 'Arrival', type: 'date', required: true })
      + field({ name: 'departure', label: 'Departure', type: 'date', required: true })
      + field({ name: 'adults', label: 'Adults', type: 'number', value: '2', required: true })
      + field({ name: 'children', label: 'Children', type: 'number', value: '0' })
      + field({ name: 'base_rate', label: 'Nightly rate', type: 'number', value: '100', required: true })
      + selectField({ name: 'currency', label: 'Currency', value: 'USD', options: CURRENCIES })
      + field({ name: 'external_ref', label: 'Reference (optional)' })
      + '</div>'
      + `<div class="mt-3">${btn('Create booking', { action: 'bk-create', icon: 'event_available' })}</div>`);
  }

  function manageCard() {
    return card(sectionTitle('Manage a reservation')
      + '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">'
      + field({ name: 'reservation_id', label: 'Reservation ID', required: true })
      + `<div class="flex gap-2">${btn('Update', { action: 'bk-update', variant: 'ghost', icon: 'edit' })}${btn('Cancel booking', { action: 'bk-cancel', variant: 'ghost', icon: 'cancel' })}</div>`
      + '</div>'
      + '<p class="mt-2 text-xs text-slate">Update re-prices using the booking form above; Cancel releases the reservation via the Booking Engine.</p>');
  }

  return {
    render(outlet) {
      if (!canBook) {
        outlet.innerHTML = pageHeader('New Booking', 'Booking Engine') + infoBanner('You do not have permission to create bookings.', 'lock');
        return;
      }
      outlet.innerHTML = pageHeader('New Booking', 'Create reservations via the Booking Engine — the single reservation entry point')
        + '<div id="bk-result" class="mb-4"></div>'
        + '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><div id="bk-create-wrap"></div>' + manageCard() + '</div>';

      const wrap = outlet.querySelector('#bk-create-wrap');
      wrap.innerHTML = bookingForm([]);
      (services.rooms && services.rooms.roomTypes ? services.rooms.roomTypes() : Promise.resolve([]))
        .then((res) => { const rts = asArray(res); if (rts.length) wrap.innerHTML = bookingForm(rts); })
        .catch(() => {});

      const result = outlet.querySelector('#bk-result');
      const idOf = () => { const el = outlet.querySelector('[name="reservation_id"]'); return el ? String(el.value || '').trim() : ''; };

      on(outlet, '[data-action="bk-create"]', 'click', async () => {
        try { const r = await services.booking.create(readForm(outlet)); result.innerHTML = successCard(r); toast('Booking created', 'success'); }
        catch (e) { result.innerHTML = rejectCard(e); toast((e && e.message) || 'Booking failed', 'error'); }
      });
      on(outlet, '[data-action="bk-update"]', 'click', async () => {
        const id = idOf(); if (!id) return toast('Enter a reservation ID', 'error');
        try { const r = await services.booking.update(id, readForm(outlet)); result.innerHTML = successCard(r); toast('Booking updated', 'success'); }
        catch (e) { result.innerHTML = rejectCard(e); toast((e && e.message) || 'Update failed', 'error'); }
      });
      on(outlet, '[data-action="bk-cancel"]', 'click', async () => {
        const id = idOf(); if (!id) return toast('Enter a reservation ID', 'error');
        try { const r = await services.booking.cancel(id, {}); result.innerHTML = successCard(r); toast('Booking cancelled', 'success'); }
        catch (e) { result.innerHTML = rejectCard(e); toast((e && e.message) || 'Cancel failed', 'error'); }
      });
    }
  };
}
