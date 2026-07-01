// Availability - single-date room availability and a date-range inventory
// calendar. Backed by /api/pms/availability + /availability/calendar.
import { pageHeader, card, table, btn, field, selectField, toolbar, sectionTitle, loading, errorState } from '../../components/ui.js';
import { on } from '../../utils/dom.js';
import { date, num, dash, isoDay } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';

export function AvailabilityView({ services }) {
  let roomTypes = [];

  function loadByDate(outlet) {
    const el = outlet.querySelector('#av-date');
    const d = (outlet.querySelector('[name="date"]') || {}).value || isoDay(0);
    const rt = (outlet.querySelector('[name="rt"]') || {}).value || undefined;
    el.innerHTML = loading();
    services.availability.byDate({ date: d, room_type_id: rt }).then((res) => {
      const data = asObject(res);
      const rows = asArray(res.data || res.result || data.byType || data.rooms || res);
      el.innerHTML = card(sectionTitle('Availability — ' + d) + (rows.length ? table([
        { key: 'room_type_code', label: 'Room type', render: (x) => dash(x.room_type_code || x.code) },
        { key: 'available', label: 'Available', render: (x) => num(x.available ?? x.available_count) },
        { key: 'total', label: 'Total', render: (x) => num(x.total ?? x.total_rooms) },
        { key: 'occupied', label: 'Occupied', render: (x) => num(x.occupied ?? x.occupied_count) }
      ], rows, { empty: 'No availability data' }) : `<pre class="text-xs text-slate overflow-x-auto">${JSON.stringify(data, null, 2)}</pre>`));
    }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Availability unavailable'); });
  }

  function loadCalendar(outlet) {
    const el = outlet.querySelector('#av-cal');
    const from = (outlet.querySelector('[name="from"]') || {}).value || isoDay(0);
    const to = (outlet.querySelector('[name="to"]') || {}).value || isoDay(13);
    const rt = (outlet.querySelector('[name="rt"]') || {}).value || undefined;
    el.innerHTML = loading();
    services.availability.calendar({ date_from: from, date_to: to, room_type_id: rt }).then((res) => {
      const rows = asArray(res);
      el.innerHTML = card(sectionTitle('Inventory calendar') + table([
        { key: 'date', label: 'Date', render: (x) => date(x.date || x.business_date) },
        { key: 'room_type_code', label: 'Type', render: (x) => dash(x.room_type_code) },
        { key: 'available', label: 'Available', render: (x) => num(x.available ?? x.available_count) },
        { key: 'sold', label: 'Sold', render: (x) => num(x.sold ?? x.occupied) }
      ], rows, { empty: 'No calendar data' }));
    }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Calendar unavailable'); });
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Availability', 'Room availability & inventory calendar')
        + `<form id="av-controls">${toolbar(`
            ${selectField({ name: 'rt', label: 'Room type', options: [] })}
            ${field({ name: 'date', label: 'Date', type: 'date', value: isoDay(0) })}
            ${field({ name: 'from', label: 'From', type: 'date', value: isoDay(0) })}
            ${field({ name: 'to', label: 'To', type: 'date', value: isoDay(13) })}
            <div>${btn('Apply', { action: 'av-apply', icon: 'filter_list' })}</div>`)}</form>
          <div id="av-date" class="mb-6"></div><div id="av-cal"></div>`;
      services.rooms.roomTypes().then((r) => {
        roomTypes = asArray(r);
        const sel = outlet.querySelector('[name="rt"]');
        if (sel) sel.innerHTML = '<option value="">All types</option>' + roomTypes.map((x) => `<option value="${x.id}">${x.code} — ${x.name}</option>`).join('');
      }).catch(() => {});
      loadByDate(outlet); loadCalendar(outlet);
      on(outlet, '[data-action="av-apply"]', 'click', (e) => { e.preventDefault(); loadByDate(outlet); loadCalendar(outlet); });
      on(outlet, '#av-controls', 'submit', (e) => { e.preventDefault(); loadByDate(outlet); loadCalendar(outlet); });
    }
  };
}
