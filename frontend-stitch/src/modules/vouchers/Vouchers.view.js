// Vouchers - lookup by number, issue, redeem, cancel. The backend exposes no
// list endpoint, so this is a lookup/action workspace. Backed by /api/pms/vouchers.
import { pageHeader, card, sectionTitle, btn, field, selectField, definitionList, statusBadge, infoBanner, loading, emptyState } from '../../components/ui.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, titleCase, money, date } from '../../utils/format.js';
import { asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const VOUCHER_TYPES = ['DISCOUNT', 'COMPLIMENTARY', 'CREDIT', 'PACKAGE'];

export function VouchersView({ services, session }) {
  const p = session.getPrincipal();
  const canIssue = can(p, 'voucher.write');
  const canRedeem = can(p, 'voucher.redeem');

  function showVoucher(outlet, v) {
    const el = outlet.querySelector('#v-detail');
    if (!v || !v.voucher_number) { el.innerHTML = emptyState('No voucher found for that number', 'confirmation_number'); return; }
    const status = String(v.status || '').toUpperCase();
    const actions = [];
    if (canRedeem && status === 'ISSUED') actions.push(btn('Redeem', { action: 'v-redeem', id: v.voucher_number, icon: 'redeem' }));
    if (canIssue && status === 'ISSUED') actions.push(btn('Cancel', { action: 'v-cancel', id: v.voucher_number, variant: 'danger', icon: 'block' }));
    el.innerHTML = card(sectionTitle('Voucher ' + v.voucher_number, actions.join('')) + definitionList([
      ['Status', statusBadge(v.status)],
      ['Type', titleCase(v.voucher_type)],
      ['Value', dash(v.amount != null ? money(v.amount, v.currency) : v.discount_pct != null ? v.discount_pct + '%' : null)],
      ['Holder', dash(v.holder_name || v.guest_name)],
      ['Issued', date(v.issued_at || v.created_at)],
      ['Valid until', date(v.valid_until || v.expires_at)],
      ['Notes', dash(v.notes)]
    ]));
  }

  async function lookup(outlet) {
    const n = (outlet.querySelector('[name="vnum"]') || {}).value;
    if (!n) { toast('Enter a voucher number', 'error'); return; }
    const el = outlet.querySelector('#v-detail');
    el.innerHTML = loading();
    try { showVoucher(outlet, asObject(await services.vouchers.byNumber(n))); }
    catch (e) { el.innerHTML = emptyState((e && e.message) || 'Voucher not found', 'confirmation_number'); }
  }

  function openIssue(outlet) {
    const el = outlet.querySelector('#v-detail');
    el.innerHTML = card(sectionTitle('Issue Voucher') + `<form id="vform" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${selectField({ name: 'voucher_type', label: 'Type', value: 'DISCOUNT', placeholder: '', options: VOUCHER_TYPES.map((t) => ({ value: t, label: titleCase(t) })) })}
      ${field({ name: 'amount', label: 'Amount', type: 'number' })}
      ${field({ name: 'discount_pct', label: 'Discount %', type: 'number' })}
      ${field({ name: 'holder_name', label: 'Holder name' })}
      ${field({ name: 'valid_until', label: 'Valid until', type: 'date' })}
      </form><div class="flex justify-end gap-2 mt-4">${btn('Issue voucher', { action: 'v-issue-go', icon: 'add_card' })}</div>`);
    on(el, '[data-action="v-issue-go"]', 'click', async () => {
      const d = Object.fromEntries(new FormData(el.querySelector('#vform')).entries());
      const body = {}; for (const [k, val] of Object.entries(d)) if (val !== '') body[k] = val;
      try { const r = asObject(await services.vouchers.issue(body)); toast('Voucher issued', 'success'); showVoucher(outlet, r); }
      catch (e) { toast((e && e.message) || 'Issue failed', 'error'); }
    });
  }

  return {
    render(outlet) {
      const actions = canIssue ? btn('Issue Voucher', { action: 'v-issue', icon: 'add_card' }) : '';
      outlet.innerHTML = pageHeader('Vouchers', 'Issue, redeem and manage vouchers', actions)
        + card(`<form id="v-look" class="flex flex-wrap items-end gap-3">
            ${field({ name: 'vnum', label: 'Voucher number', placeholder: 'e.g. VCH-2026-000001' })}
            <div>${btn('Look up', { action: 'v-find', icon: 'search' })}</div></form>`, 'mb-5')
        + `<div id="v-detail">${infoBanner('Look up a voucher by number, or issue a new one.')}</div>`;
      on(outlet, '[data-action="v-find"]', 'click', (e) => { e.preventDefault(); lookup(outlet); });
      on(outlet, '#v-look', 'submit', (e) => { e.preventDefault(); lookup(outlet); });
      on(outlet, '[data-action="v-issue"]', 'click', () => openIssue(outlet));
      on(outlet, '[data-action="v-redeem"]', 'click', async (e, t) => {
        const reservationId = prompt('Reservation ID to redeem against:'); // simple, deterministic prompt
        if (!reservationId) return;
        try { await services.vouchers.redeem(t.getAttribute('data-id'), reservationId); toast('Voucher redeemed', 'success'); lookup(outlet); }
        catch (err) { toast((err && err.message) || 'Redeem failed', 'error'); }
      });
      on(outlet, '[data-action="v-cancel"]', 'click', async (e, t) => {
        const reason = prompt('Cancellation reason:') || '';
        try { await services.vouchers.cancel(t.getAttribute('data-id'), reason); toast('Voucher cancelled', 'success'); lookup(outlet); }
        catch (err) { toast((err && err.message) || 'Cancel failed', 'error'); }
      });
    }
  };
}
