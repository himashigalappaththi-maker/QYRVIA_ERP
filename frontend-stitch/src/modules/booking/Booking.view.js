// Booking Engine — Phase 52: two-step Quote → Confirm flow.
// Step 1: form fields → GET /api/booking/quote → show pricing panel
// Step 2: confirm step → guest selector + notes → POST /api/booking/create
// Manage card (update / cancel) is preserved from Phase 26.
import { pageHeader, card, sectionTitle, field, selectField, btn, infoBanner, statusBadge } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';
import { esc } from '../../utils/dom.js';

export function BookingView({ services, session }) {
  const principal = session.getPrincipal();
  const canBook = can(principal, 'pms.reservation.write');

  // ---- Success / reject cards (manage section, preserved from Phase 26) ----
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

  // ---- Manage card (update / cancel an existing reservation) ---------------
  function manageCard() {
    return card(sectionTitle('Manage a reservation')
      + '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">'
      + field({ name: 'reservation_id', label: 'Reservation ID', required: true })
      + `<div class="flex gap-2">${btn('Update', { action: 'bk-update', variant: 'ghost', icon: 'edit' })}${btn('Cancel booking', { action: 'bk-cancel', variant: 'ghost', icon: 'cancel' })}</div>`
      + '</div>'
      + '<p class="mt-2 text-xs text-slate">Update re-prices via the Booking Engine; Cancel releases the reservation.</p>');
  }

  // ---- Quote result panel (used in both step 1 and step 2 summary) ---------
  function quoteResultPanel(quote, { showConfirmButton = false } = {}) {
    if (!quote) return '';
    if (quote._ari_not_configured) {
      return infoBanner('Rate plans not configured. Set up ARI rate plans first.', 'info');
    }
    if (!quote.bookable) {
      const reasons = (quote.reasons || [quote.reason]).filter(Boolean);
      return `<div class="rounded-lg bg-error-container px-4 py-3 text-sm text-on-error-container mt-3">
        <div class="flex items-start gap-2"><span class="material-symbols-outlined text-base">block</span>
        <div><p class="font-medium">Not available</p>
        ${reasons.length ? `<ul class="mt-1 list-disc list-inside">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</div></div></div>`;
    }
    const nightly = (quote.nightly_rates || []);
    const nightlyRows = nightly.map((n) =>
      `<tr><td class="text-slate py-1 pr-4 text-xs">${esc(n.date)}</td><td class="text-right text-xs font-medium">${esc(String(n.currency || quote.currency || ''))} ${esc(String(n.rate))}</td></tr>`
    ).join('');
    return `<div class="rounded-lg bg-primary-container/20 border border-outline-variant/40 px-4 py-3 mt-3">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs uppercase tracking-wider text-slate">Quote</span>
        <span class="font-display text-lg font-bold text-on-surface">${esc(String(quote.currency || ''))} ${esc(String(quote.total))}</span>
      </div>
      ${quote.rate_plan_name ? `<p class="text-xs text-slate mb-2">Rate plan: <span class="text-on-surface font-medium">${esc(quote.rate_plan_name)}</span></p>` : ''}
      <p class="text-xs text-slate mb-2">LOS: <span class="text-on-surface font-medium">${esc(String(quote.los || ''))}</span> night${Number(quote.los) !== 1 ? 's' : ''} &nbsp;·&nbsp; Availability: <span class="text-on-surface font-medium">${esc(String(quote.available || ''))}</span> room${Number(quote.available) !== 1 ? 's' : ''}</p>
      ${nightly.length ? `<table class="w-full mt-1"><tbody>${nightlyRows}</tbody></table>` : ''}
      ${showConfirmButton ? `<div class="mt-3">${btn('Continue to Confirm', { action: 'bk-step-confirm', icon: 'arrow_forward' })}</div>` : ''}
    </div>`;
  }

  // ---- Step 1: Quote form --------------------------------------------------
  function quoteForm(state) {
    const { refs, refsLoaded, quoting, formValues: fv } = state;
    const rtOpts = refsLoaded
      ? refs.roomTypes.map((r) => ({ value: r.id || r.code, label: r.name || r.code || String(r.id) }))
      : [{ value: '', label: 'Loading…' }];
    const rpOpts = refsLoaded
      ? [{ value: '', label: 'Best available' }, ...refs.ratePlans.map((r) => ({ value: r.id || r.code, label: r.name || r.code || String(r.id) }))]
      : [{ value: '', label: 'Loading…' }];

    const qbDisabled = quoting || !refsLoaded;
    const qbLabel = quoting ? 'Checking…' : 'Check Availability and Quote';

    return `<p class="text-xs uppercase tracking-wider text-slate mb-2">Step 1 of 2 — Check availability</p>`
      + card(sectionTitle('Book a stay')
        + '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">'
        + selectField({ name: 'room_type_id', label: 'Room type', options: rtOpts, value: fv.room_type_id || '', required: true })
        + selectField({ name: 'rate_plan_id', label: 'Rate plan', options: rpOpts, value: fv.rate_plan_id || '' })
        + field({ name: 'arrival', label: 'Arrival', type: 'date', value: fv.arrival || '', required: true })
        + field({ name: 'departure', label: 'Departure', type: 'date', value: fv.departure || '', required: true })
        + field({ name: 'adults', label: 'Adults', type: 'number', value: fv.adults != null ? String(fv.adults) : '2', extra: 'min="1"', required: true })
        + field({ name: 'children', label: 'Children', type: 'number', value: fv.children != null ? String(fv.children) : '0', extra: 'min="0"' })
        + selectField({ name: 'channel', label: 'Channel', options: [
            { value: 'DIRECT', label: 'Direct' },
            { value: 'OTA', label: 'OTA' },
            { value: 'CORPORATE', label: 'Corporate' },
            { value: 'TRAVEL_AGENT', label: 'Travel Agent' }
          ], value: fv.channel || 'DIRECT' })
        + field({ name: 'external_ref', label: 'Reference (optional)', value: fv.external_ref || '' })
        + '</div>'
        + `<div id="bk-quote-result">${state.quote ? quoteResultPanel(state.quote, { showConfirmButton: state.quote.bookable }) : ''}</div>`
        + `<div class="mt-3">${btn(qbLabel, { action: 'bk-quote', extra: qbDisabled ? 'disabled' : '' })}</div>`
      );
  }

  // ---- Step 2: Confirm card ------------------------------------------------
  function confirmStep(state) {
    const { refs, quote, formValues: fv, confirming } = state;
    const guests = refs.guests || [];
    const hasGuest = guests.length > 0;
    const confirmDisabled = confirming || !hasGuest;

    // Lookup labels for read-only summary
    const rtLabel = refs.roomTypes.find((r) => String(r.id || r.code) === String(fv.room_type_id))
      ? (refs.roomTypes.find((r) => String(r.id || r.code) === String(fv.room_type_id)).name || fv.room_type_id)
      : fv.room_type_id || '—';
    const rpLabel = fv.rate_plan_id
      ? (refs.ratePlans.find((r) => String(r.id || r.code) === String(fv.rate_plan_id))
          ? (refs.ratePlans.find((r) => String(r.id || r.code) === String(fv.rate_plan_id)).name || fv.rate_plan_id)
          : fv.rate_plan_id)
      : (quote && quote.rate_plan_name ? quote.rate_plan_name : 'Best available');

    const guestOpts = guests.map((g) => ({
      value: g.id,
      label: `${g.first_name || ''} ${g.last_name || ''}`.trim() + (g.organization_name ? ` (${g.organization_name})` : '')
    }));

    const labelCls = 'block text-xs uppercase tracking-wider text-slate mb-1';
    const inputCls = 'w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none bg-surface';

    return `<p class="text-xs uppercase tracking-wider text-slate mb-2">Step 2 of 2 — Confirm booking</p>`
      + card(sectionTitle('Confirm booking')
        + `<dl class="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2 text-sm mb-4 pb-4 border-b border-outline-variant/40">
            <dt class="text-slate">Room type</dt><dd class="col-span-1 font-medium">${esc(rtLabel)}</dd>
            <dt class="text-slate">Rate plan</dt><dd class="col-span-1 font-medium">${esc(rpLabel)}</dd>
            <dt class="text-slate">Arrival</dt><dd class="col-span-1 font-medium">${esc(fv.arrival || '—')}</dd>
            <dt class="text-slate">Departure</dt><dd class="col-span-1 font-medium">${esc(fv.departure || '—')}</dd>
            <dt class="text-slate">LOS</dt><dd class="col-span-1 font-medium">${esc(String(quote && quote.los != null ? quote.los : '—'))}</dd>
            <dt class="text-slate">Guests</dt><dd class="col-span-1 font-medium">${esc(String(fv.adults || 2))} adults, ${esc(String(fv.children || 0))} children</dd>
            <dt class="text-slate">Channel</dt><dd class="col-span-1 font-medium">${esc(fv.channel || 'DIRECT')}</dd>
            ${fv.external_ref ? `<dt class="text-slate">Reference</dt><dd class="col-span-1 font-medium">${esc(fv.external_ref)}</dd>` : ''}
          </dl>`
        + (quote ? quoteResultPanel(quote) : '')
        + `<div class="mt-4 space-y-3">`
        + (!hasGuest
            ? infoBanner('No guests found. Create a guest in the Guests module first.', 'warning')
            : selectField({ name: 'holder_guest_id', label: 'Guest', options: guestOpts, required: true })
          )
        + `<div><label class="${labelCls}">Notes</label>
            <textarea name="notes" class="${inputCls}" rows="2" placeholder="Booking notes…"></textarea></div>`
        + `<div id="bk-confirm-error"></div>`
        + `<div class="flex flex-wrap gap-2 mt-2">
            ${btn(confirming ? 'Confirming…' : 'Confirm Booking', { action: 'bk-confirm', icon: 'check', extra: confirmDisabled ? 'disabled' : '' })}
            ${btn('Back / Edit', { action: 'bk-back', variant: 'ghost', icon: 'arrow_back' })}
          </div>`
        + `</div>`
      );
  }

  // ---- Step 3: Done --------------------------------------------------------
  function doneCard(r) {
    const res = (r && r.result) || (r && r.data) || r || {};
    const resId = res.reservation_id || res.id || '—';
    return card(sectionTitle('Booking confirmed')
      + `<p class="text-sm">Reservation: <b>${esc(String(resId))}</b> ${statusBadge('CONFIRMED')}</p>`
      + `<p class="mt-2 text-sm text-slate">Your booking has been successfully created through the Booking Engine.</p>`
      + `<div class="mt-3">${btn('New booking', { action: 'bk-new', variant: 'ghost', icon: 'add' })}</div>`
    );
  }

  return {
    render(outlet) {
      if (!canBook) {
        outlet.innerHTML = pageHeader('New Booking', 'Booking Engine') + infoBanner('You do not have permission to create bookings.', 'lock');
        return;
      }

      // ---- state model -------------------------------------------------------
      let state = {
        step: 'form',
        quote: null,
        formValues: {},
        refs: { roomTypes: [], ratePlans: [], guests: [] },
        refsLoaded: false,
        quoting: false,
        confirming: false,
        _lastConfirmResult: null
      };

      // ---- DOM skeleton -------------------------------------------------------
      outlet.innerHTML = pageHeader('New Booking', 'Create reservations via the Booking Engine — the single reservation entry point')
        + '<div id="bk-result" class="mb-4"></div>'
        + '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><div id="bk-create-wrap"></div>' + manageCard() + '</div>';

      const wrap = outlet.querySelector('#bk-create-wrap');
      const resultSlot = outlet.querySelector('#bk-result');

      function redrawWrap() {
        if (state.step === 'form') {
          wrap.innerHTML = quoteForm(state);
        } else if (state.step === 'confirm') {
          wrap.innerHTML = confirmStep(state);
        } else if (state.step === 'done') {
          wrap.innerHTML = doneCard(state._lastConfirmResult);
        }
      }

      redrawWrap();

      // ---- Load refs ---------------------------------------------------------
      Promise.all([
        services.rooms && services.rooms.roomTypes ? services.rooms.roomTypes().catch(() => []) : Promise.resolve([]),
        services.ari && services.ari.ratePlans ? services.ari.ratePlans().catch(() => []) : Promise.resolve([]),
        services.guests && services.guests.list ? services.guests.list({}).catch(() => []) : Promise.resolve([])
      ]).then(([rawRt, rawRp, rawG]) => {
        state.refs = {
          roomTypes: asArray(rawRt),
          ratePlans: asArray(rawRp),
          guests: asArray(rawG)
        };
        state.refsLoaded = true;
        if (state.step === 'form') redrawWrap();
      });

      // ---- Helper: read quote-form values ------------------------------------
      function readQuoteForm() {
        const get = (n) => { const el = wrap.querySelector(`[name="${n}"]`); return el ? String(el.value || '').trim() : ''; };
        return {
          room_type_id: get('room_type_id'),
          rate_plan_id: get('rate_plan_id'),
          arrival: get('arrival'),
          departure: get('departure'),
          adults: Number(get('adults') || 2),
          children: Number(get('children') || 0),
          channel: get('channel') || 'DIRECT',
          external_ref: get('external_ref') || undefined
        };
      }

      // ---- Action: bk-quote --------------------------------------------------
      on(outlet, '[data-action="bk-quote"]', 'click', async () => {
        if (state.quoting || !state.refsLoaded) return;
        state.formValues = readQuoteForm();
        state.quoting = true;
        state.quote = null;
        redrawWrap();
        try {
          const q = { ...state.formValues };
          if (!q.external_ref) delete q.external_ref;
          const res = await services.booking.quote(q);
          // Normalise: backend may return { ok, data } envelope
          const data = (res && res.data != null) ? res.data : (res && res.ok != null ? res : res);
          if (data && data.bookable === false && data.reason === 'ari_not_configured') {
            state.quote = { bookable: false, _ari_not_configured: true };
          } else if (data && data.bookable === true) {
            state.quote = data;
          } else {
            // Non-bookable: reasons from data or error shape
            state.quote = { bookable: false, reasons: (data && data.reasons) || [] };
          }
        } catch (e) {
          // HTTP 400 non-bookable or real error
          const errData = e && e.data;
          if (errData && errData.error === 'not_bookable') {
            state.quote = { bookable: false, reasons: errData.reasons || [] };
          } else {
            state.quote = { bookable: false, reasons: [(e && e.message) || 'An error occurred'] };
            toast((e && e.message) || 'Quote failed', 'error');
          }
        } finally {
          state.quoting = false;
          redrawWrap();
        }
      });

      // ---- Action: bk-step-confirm -------------------------------------------
      on(outlet, '[data-action="bk-step-confirm"]', 'click', () => {
        if (!state.quote || !state.quote.bookable) return;
        state.step = 'confirm';
        redrawWrap();
        // Focus guest selector
        const guestEl = wrap.querySelector('[name="holder_guest_id"]');
        if (guestEl) guestEl.focus();
      });

      // ---- Action: bk-back ---------------------------------------------------
      on(outlet, '[data-action="bk-back"]', 'click', () => {
        state.step = 'form';
        redrawWrap();
        // Focus quote button after re-render
        const qBtn = wrap.querySelector('[data-action="bk-quote"]');
        if (qBtn) qBtn.focus();
      });

      // ---- Action: bk-confirm ------------------------------------------------
      on(outlet, '[data-action="bk-confirm"]', 'click', async () => {
        if (state.confirming) return;
        const holderEl = wrap.querySelector('[name="holder_guest_id"]');
        const notesEl = wrap.querySelector('[name="notes"]');
        const holder_guest_id = holderEl ? String(holderEl.value || '').trim() : '';
        const notes = notesEl ? String(notesEl.value || '').trim() : '';
        if (!holder_guest_id) { toast('Please select a guest', 'error'); return; }

        state.confirming = true;
        redrawWrap();

        const payload = {
          ...state.formValues,
          holder_guest_id,
          notes: notes || undefined,
          rate_plan_id: (state.quote && state.quote.rate_plan_id) || state.formValues.rate_plan_id || undefined
        };
        if (!payload.notes) delete payload.notes;
        if (!payload.rate_plan_id) delete payload.rate_plan_id;
        if (!payload.external_ref) delete payload.external_ref;

        try {
          const r = await services.booking.create(payload);
          state._lastConfirmResult = r;
          state.step = 'done';
          state.confirming = false;
          redrawWrap();
          toast('Booking confirmed', 'success');
        } catch (e) {
          state.confirming = false;
          redrawWrap();
          // Show inline error in confirm step
          const errSlot = wrap.querySelector('#bk-confirm-error');
          if (errSlot) {
            errSlot.innerHTML = `<div class="rounded-lg bg-error-container px-4 py-3 text-sm text-on-error-container mt-2">
              <div class="flex items-start gap-2"><span class="material-symbols-outlined text-base">error</span>
              <span>${esc((e && e.message) || 'Booking failed')}</span></div></div>`;
          }
          toast((e && e.message) || 'Booking failed', 'error');
        }
      });

      // ---- Action: bk-new (reset after done) ---------------------------------
      on(outlet, '[data-action="bk-new"]', 'click', () => {
        state.step = 'form';
        state.quote = null;
        state.formValues = {};
        state.confirming = false;
        state.quoting = false;
        resultSlot.innerHTML = '';
        redrawWrap();
      });

      // ---- Action: bk-update (manage card) -----------------------------------
      const idOf = () => { const el = outlet.querySelector('[name="reservation_id"]'); return el ? String(el.value || '').trim() : ''; };
      on(outlet, '[data-action="bk-update"]', 'click', async () => {
        const id = idOf(); if (!id) return toast('Enter a reservation ID', 'error');
        const body = { ...state.formValues };
        // Do not send base_rate or currency
        delete body.base_rate;
        delete body.currency;
        if (!body.external_ref) delete body.external_ref;
        try { const r = await services.booking.update(id, body); resultSlot.innerHTML = successCard(r); toast('Booking updated', 'success'); }
        catch (e) { resultSlot.innerHTML = rejectCard(e); toast((e && e.message) || 'Update failed', 'error'); }
      });

      // ---- Action: bk-cancel (manage card) -----------------------------------
      on(outlet, '[data-action="bk-cancel"]', 'click', async () => {
        const id = idOf(); if (!id) return toast('Enter a reservation ID', 'error');
        try { const r = await services.booking.cancel(id, {}); resultSlot.innerHTML = successCard(r); toast('Booking cancelled', 'success'); }
        catch (e) { resultSlot.innerHTML = rejectCard(e); toast((e && e.message) || 'Cancel failed', 'error'); }
      });
    }
  };
}
