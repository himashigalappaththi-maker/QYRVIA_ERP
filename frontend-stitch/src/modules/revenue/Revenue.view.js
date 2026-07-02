// Revenue Management - KPIs + dashboard + pricing calendar (rate grid) +
// forecast + manual override. Backed by /api/revenue/* (deterministic engine).
// Payloads arrive as { result }; rendering is defensive about exact field names.
import { pageHeader, card, kpiCard, table, btn, selectField, field, toolbar, modal, loading, errorState, sectionTitle } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { money, pct, date, num, titleCase, isoDay } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

function metricValue(k, v) {
  if (v == null) return '—';
  if (typeof v === 'number') {
    if (/pct|occupancy|rate/i.test(k) && v <= 1.5) return pct(v * 100);
    if (/adr|revpar|revenue|amount|total/i.test(k)) return money(v);
    return num(v);
  }
  return String(v);
}

export function RevenueView({ services, session }) {
  const principal = session.getPrincipal();
  const canWrite = can(principal, 'revenue.snapshot.write');
  let roomTypes = [];

  function renderMetrics(el, obj, title) {
    const entries = Object.entries(obj || {}).filter(([, v]) => v == null || typeof v !== 'object');
    if (!entries.length) { el.innerHTML = ''; return; }
    el.innerHTML = sectionTitle(title) + `<div class="grid grid-cols-2 md:grid-cols-4 gap-4">` +
      entries.slice(0, 8).map(([k, v]) => kpiCard({ label: titleCase(k), value: metricValue(k, v), icon: 'insights' })).join('') + `</div>`;
  }

  function loadKpis(outlet) {
    const el = outlet.querySelector('#rev-kpis');
    services.revenue.kpis({}).then((r) => renderMetrics(el, asObject(r), 'KPIs'))
      .catch((e) => { el.innerHTML = errorState((e && e.message) || 'KPIs unavailable'); });
  }
  function loadDashboard(outlet) {
    const el = outlet.querySelector('#rev-dash');
    services.revenue.dashboard({}).then((r) => {
      const d = asObject(r);
      // dashboard may nest a summary object; flatten the top scalar layer
      renderMetrics(el, d.summary || d, 'Dashboard');
    }).catch(() => { el.innerHTML = ''; });
  }

  function loadGrid(outlet) {
    const el = outlet.querySelector('#rev-grid');
    const rt = (outlet.querySelector('[name="rt"]') || {}).value;
    const from = (outlet.querySelector('[name="from"]') || {}).value || isoDay(0);
    const to = (outlet.querySelector('[name="to"]') || {}).value || isoDay(6);
    if (!rt) { el.innerHTML = card('<p class="text-slate text-sm">Select a room type to view the pricing calendar.</p>'); return; }
    el.innerHTML = loading();
    services.revenue.rateGrid({ room_type_id: rt, date_from: from, date_to: to }).then((r) => {
      const rows = asArray(r);
      el.innerHTML = card(sectionTitle('Pricing calendar') + table([
        { key: 'businessDate', label: 'Date', render: (x) => date(x.businessDate || x.date) },
        { key: 'computedRate', label: 'Rate', render: (x) => money(x.computedRate ?? x.rate) },
        { key: 'demandScore', label: 'Demand', render: (x) => num(x.demandScore) },
        { key: 'seasonalMultiplier', label: 'Seasonal', render: (x) => x.seasonalMultiplier ?? '—' },
        { key: 'confidenceScore', label: 'Confidence', render: (x) => x.confidenceScore ?? '—' }
      ], rows, { empty: 'No pricing data (configure a rate plan first)' }));
    }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Rate grid unavailable'); });
  }

  function loadForecast(outlet) {
    const el = outlet.querySelector('#rev-forecast');
    const from = (outlet.querySelector('[name="from"]') || {}).value || isoDay(0);
    const to = (outlet.querySelector('[name="to"]') || {}).value || isoDay(13);
    services.revenue.forecast({ date_from: from, date_to: to }).then((r) => {
      const rows = asArray(r);
      if (!rows.length) { el.innerHTML = ''; return; }
      el.innerHTML = card(sectionTitle('Forecast') + table([
        { key: 'date', label: 'Date', render: (x) => date(x.date || x.businessDate) },
        { key: 'occupancyPct', label: 'Occupancy', render: (x) => pct((x.occupancyPct ?? x.occupancy ?? 0) * (x.occupancyPct <= 1.5 ? 100 : 1)) },
        { key: 'demandScore', label: 'Demand', render: (x) => num(x.demandScore) }
      ], rows, { empty: 'No forecast' }));
    }).catch(() => { el.innerHTML = ''; });
  }

  function openOverride(outlet) {
    openOverlay(modal({ id: 'ov', title: 'Manual Rate Override', body: `<form id="ov-form" class="space-y-4">
      ${selectField({ name: 'room_type_id', label: 'Room type', required: true, options: roomTypes.map((x) => ({ value: x.id, label: `${x.code} — ${x.name}` })) })}
      ${field({ name: 'date', label: 'Date', type: 'date', required: true, value: isoDay(0) })}
      ${field({ name: 'rate', label: 'Override rate', type: 'number', required: true, extra: 'step="0.01"' })}
      ${field({ name: 'reason', label: 'Reason' })}
    </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Apply override', { action: 'ov-go', icon: 'edit' })}` }), (root) => {
      on(root, '[data-action="ov-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(root.querySelector('#ov-form')).entries());
        if (!d.room_type_id || !d.date || !d.rate) { toast('Room type, date and rate required', 'error'); return; }
        try { await services.revenue.override({ room_type_id: d.room_type_id, date: d.date, rate: Number(d.rate), reason: d.reason || undefined }); toast('Override applied', 'success'); closeOverlay(); loadGrid(outlet); }
        catch (e) { toast((e && e.message) || 'Override failed', 'error'); }
      });
    });
  }

  return {
    render(outlet) {
      const actions = canWrite ? btn('Manual Override', { action: 'rev-override', icon: 'edit' }) : '';
      outlet.innerHTML = pageHeader('Revenue Management', 'Dynamic pricing, KPIs & forecasting', actions)
        + '<div id="rev-kpis" class="mb-6"></div><div id="rev-dash" class="mb-6"></div>'
        + `<form id="rev-controls">${toolbar(`
            ${selectField({ name: 'rt', label: 'Room type', options: [] })}
            ${field({ name: 'from', label: 'From', type: 'date', value: isoDay(0) })}
            ${field({ name: 'to', label: 'To', type: 'date', value: isoDay(6) })}
            <div>${btn('Apply', { action: 'rev-apply', icon: 'filter_list' })}</div>`)}</form>`
        + '<div id="rev-grid" class="mb-6"></div><div id="rev-forecast"></div>';

      loadKpis(outlet); loadDashboard(outlet);
      services.rooms.roomTypes().then((r) => {
        roomTypes = asArray(r);
        const sel = outlet.querySelector('[name="rt"]');
        if (sel) sel.innerHTML = '<option value="">Select…</option>' + roomTypes.map((x) => `<option value="${x.id}">${x.code} — ${x.name}</option>`).join('');
        loadGrid(outlet); loadForecast(outlet);
      }).catch(() => { loadGrid(outlet); loadForecast(outlet); });

      on(outlet, '[data-action="rev-apply"]', 'click', (e) => { e.preventDefault(); loadGrid(outlet); loadForecast(outlet); });
      on(outlet, '#rev-controls', 'submit', (e) => { e.preventDefault(); loadGrid(outlet); loadForecast(outlet); });
      on(outlet, '[data-action="rev-override"]', 'click', () => openOverride(outlet));
    }
  };
}
