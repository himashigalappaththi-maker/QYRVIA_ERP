// Billing - Invoices (full read: list / detail / issue / void) plus a Folio
// Operations console (post charge / cash payment / close / view allocations).
// Note: the backend exposes no folio LIST route, so folio ops are keyed by a
// folio id (surfaced at check-in). This is reflected honestly in the UI.
import { pageHeader, card, table, statusBadge, btn, tabs, field, selectField, textareaField, toolbar, modal, drawer, definitionList, loading, errorState, infoBanner, emptyState } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { money, date, datetime, dash, titleCase } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const CHARGE_TYPES = ['ROOM', 'ROOM_TAX', 'PACKAGE', 'EXTRA_BED', 'MINIBAR', 'POS_CHARGE', 'LAUNDRY', 'TELEPHONE', 'INTERNET', 'SPA', 'TRANSFER', 'MISC'];

export function BillingView({ services, session }) {
  const principal = session.getPrincipal();
  const canIssue = can(principal, 'invoice.write');
  const canVoid = can(principal, 'invoice.void');
  const canPost = can(principal, 'folio.post');
  const canClose = can(principal, 'folio.close');
  let active = 'invoices';

  // ---- Invoices ----
  function loadInvoices(outlet) {
    const body = outlet.querySelector('#bill-body');
    const status = (outlet.querySelector('[name="inv_status"]') || {}).value || undefined;
    body.innerHTML = loading();
    services.billing.invoices({ status }).then((res) => {
      const rows = asArray(res);
      body.innerHTML = card(table([
        { key: 'invoice_number', label: 'Invoice', render: (r) => `<button data-inv="${r.id}" class="text-primary font-medium hover:underline">${r.invoice_number || r.id}</button>` },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'total', label: 'Total', render: (r) => money(r.total ?? r.total_amount, r.currency) },
        { key: 'issued_at', label: 'Issued', render: (r) => datetime(r.issued_at || r.created_at) }
      ], rows, { empty: 'No invoices' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load invoices'); });
  }

  function openInvoice(outlet, id) {
    openOverlay(drawer({ id: 'inv', title: 'Invoice', body: `<div id="inv-body">${loading()}</div>` }), async (root) => {
      const el = root.querySelector('#inv-body');
      let inv;
      try { inv = asObject(await services.billing.invoiceById(id)); }
      catch (e) { el.innerHTML = `<p class="text-error text-sm">${(e && e.message) || 'Failed'}</p>`; return; }
      el.innerHTML = definitionList([
        ['Number', inv.invoice_number || inv.id],
        ['Status', statusBadge(inv.status)],
        ['Total', money(inv.total ?? inv.total_amount, inv.currency)],
        ['Folio', dash(inv.folio_id)],
        ['Issued', datetime(inv.issued_at || inv.created_at)]
      ]) + (canVoid && String(inv.status).toUpperCase() === 'ISSUED'
        ? `<div class="mt-6">${btn('Void invoice', { action: 'inv-void', variant: 'danger', icon: 'block' })}</div>` : '');
      on(el, '[data-action="inv-void"]', 'click', async () => {
        const reason = prompt('Void reason?') || undefined;
        try { await services.billing.voidInvoice(id, reason); toast('Invoice voided', 'success'); closeOverlay(); loadInvoices(outlet); }
        catch (e) { toast((e && e.message) || 'Void failed', 'error'); }
      });
    });
  }

  function openIssueInvoice(outlet) {
    openOverlay(modal({ id: 'issue', title: 'Issue Invoice from Folio',
      body: `${infoBanner('Provide the folio id to issue an invoice from (folio ids are returned at check-in).', 'receipt')}
        <form id="issue-form" class="space-y-4">${field({ name: 'folio_id', label: 'Folio id', required: true })}</form>`,
      footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Issue', { action: 'issue-go', icon: 'receipt_long' })}` }), (root) => {
      on(root, '[data-action="issue-go"]', 'click', async () => {
        const fid = (root.querySelector('[name="folio_id"]') || {}).value;
        if (!fid) { toast('Folio id required', 'error'); return; }
        try { await services.billing.issueInvoice({ folio_id: fid }); toast('Invoice issued', 'success'); closeOverlay(); loadInvoices(outlet); }
        catch (e) { toast((e && e.message) || 'Issue failed', 'error'); }
      });
    });
  }

  // ---- Folio operations ----
  function renderFolioOps(outlet) {
    const body = outlet.querySelector('#bill-body');
    body.innerHTML = card(`
      ${infoBanner('Folios are not listed by the backend; enter a folio id (shown at check-in) to operate on it.', 'account_balance_wallet')}
      <form id="folio-form" class="flex flex-wrap items-end gap-3">
        ${field({ name: 'folio_id', label: 'Folio id', required: true })}
        <div class="flex flex-wrap gap-2">
          ${btn('View allocations', { action: 'fo-alloc', variant: 'ghost', icon: 'visibility' })}
          ${canPost ? btn('Post charge', { action: 'fo-charge', icon: 'add_card' }) : ''}
          ${canPost ? btn('Cash payment', { action: 'fo-pay', variant: 'secondary', icon: 'payments' }) : ''}
          ${canClose ? btn('Close folio', { action: 'fo-close', variant: 'danger', icon: 'lock' }) : ''}
        </div>
      </form>
      <div id="folio-result" class="mt-5"></div>`);
  }

  const folioId = (outlet) => (outlet.querySelector('[name="folio_id"]') || {}).value;
  const needFolio = (outlet) => { const v = folioId(outlet); if (!v) toast('Enter a folio id first', 'error'); return v; };

  function wireFolioOps(outlet) {
    on(outlet, '[data-action="fo-alloc"]', 'click', async (e) => {
      e.preventDefault(); const id = needFolio(outlet); if (!id) return;
      const r = outlet.querySelector('#folio-result'); if (r) r.innerHTML = loading();
      try {
        const rows = asArray(await services.billing.allocations(id));
        if (r) r.innerHTML = table([
          { key: 'payment_line_id', label: 'Payment line' }, { key: 'charge_line_id', label: 'Charge line' },
          { key: 'amount', label: 'Amount', render: (x) => money(x.amount) }, { key: 'allocated_at', label: 'At', render: (x) => datetime(x.allocated_at) }
        ], rows, { empty: 'No allocations for this folio' });
      } catch (err) { if (r) r.innerHTML = `<p class="text-error text-sm">${(err && err.message) || 'Failed'}</p>`; }
    });
    on(outlet, '[data-action="fo-charge"]', 'click', (e) => { e.preventDefault(); const id = needFolio(outlet); if (id) openCharge(outlet, id); });
    on(outlet, '[data-action="fo-pay"]', 'click', (e) => { e.preventDefault(); const id = needFolio(outlet); if (id) openPayment(outlet, id); });
    on(outlet, '[data-action="fo-close"]', 'click', async (e) => {
      e.preventDefault(); const id = needFolio(outlet); if (!id) return;
      try { await services.billing.closeFolio(id, false); toast('Folio closed', 'success'); }
      catch (err) {
        const msg = (err && err.message) || 'Close failed';
        if (/balance/i.test(msg) && confirm('Folio has a balance. Force close?')) {
          try { await services.billing.closeFolio(id, true); toast('Folio force-closed', 'success'); } catch (e2) { toast((e2 && e2.message) || msg, 'error'); }
        } else toast(msg, 'error');
      }
    });
  }

  function openCharge(outlet, folioId) {
    openOverlay(modal({ id: 'charge', title: 'Post Charge', body: `<form id="charge-form" class="space-y-4">
      ${selectField({ name: 'charge_type', label: 'Charge type', required: true, options: CHARGE_TYPES })}
      ${field({ name: 'amount', label: 'Amount', type: 'number', required: true, extra: 'step="0.01"' })}
      ${textareaField({ name: 'description', label: 'Description' })}
    </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Post', { action: 'charge-go', icon: 'add_card' })}` }), (root) => {
      on(root, '[data-action="charge-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(root.querySelector('#charge-form')).entries());
        if (!d.charge_type || !d.amount) { toast('Charge type and amount required', 'error'); return; }
        try { await services.billing.postCharge(folioId, { charge_type: d.charge_type, amount: Number(d.amount), description: d.description || undefined }); toast('Charge posted', 'success'); closeOverlay(); }
        catch (e) { toast((e && e.message) || 'Post failed', 'error'); }
      });
    });
  }

  function openPayment(outlet, folioId) {
    openOverlay(modal({ id: 'pay', title: 'Cash Payment', body: `<form id="pay-form" class="space-y-4">
      ${field({ name: 'amount', label: 'Amount due', type: 'number', required: true, extra: 'step="0.01"' })}
      ${field({ name: 'tendered', label: 'Cash tendered', type: 'number', required: true, extra: 'step="0.01"' })}
    </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Take payment', { action: 'pay-go', icon: 'payments' })}` }), (root) => {
      on(root, '[data-action="pay-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(root.querySelector('#pay-form')).entries());
        if (!d.amount || !d.tendered) { toast('Amount and tendered required', 'error'); return; }
        try { const r = asObject(await services.billing.cashPayment(folioId, { amount: Number(d.amount), tendered: Number(d.tendered) })); toast('Payment taken. Change: ' + money(r.change), 'success'); closeOverlay(); }
        catch (e) { toast((e && e.message) || 'Payment failed', 'error'); }
      });
    });
  }

  function renderActive(outlet) {
    outlet.querySelector('#bill-tabs').innerHTML = tabs([
      { id: 'invoices', label: 'Invoices' }, { id: 'folio', label: 'Folio Operations' }
    ], active);
    if (active === 'invoices') {
      outlet.querySelector('#bill-toolbar').innerHTML = `<form id="inv-filter">${toolbar(`
        ${selectField({ name: 'inv_status', label: 'Status', placeholder: 'All', options: ['ISSUED', 'VOIDED', 'PROFORMA'] })}
        <div>${btn('Apply', { action: 'inv-apply', icon: 'filter_list' })}</div>
        ${canIssue ? `<div>${btn('Issue Invoice', { action: 'issue-inv', icon: 'receipt_long' })}</div>` : ''}`)}</form>`;
      loadInvoices(outlet);
    } else {
      outlet.querySelector('#bill-toolbar').innerHTML = '';
      renderFolioOps(outlet);
    }
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Billing', 'Invoices & folio operations')
        + '<div id="bill-tabs"></div><div id="bill-toolbar"></div><div id="bill-body"></div>';
      renderActive(outlet);
      wireFolioOps(outlet);   // bound once; folio ops only present on the folio tab

      on(outlet, '[data-tab]', 'click', (e, t) => { active = t.getAttribute('data-tab'); renderActive(outlet); });
      on(outlet, '[data-action="inv-apply"]', 'click', (e) => { e.preventDefault(); loadInvoices(outlet); });
      on(outlet, '#inv-filter', 'submit', (e) => { e.preventDefault(); loadInvoices(outlet); });
      on(outlet, '[data-inv]', 'click', (e, t) => openInvoice(outlet, t.getAttribute('data-inv')));
      on(outlet, '[data-action="issue-inv"]', 'click', () => openIssueInvoice(outlet));
    }
  };
}
