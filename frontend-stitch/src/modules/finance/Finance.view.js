// Accounting / Finance - cost centers (list/create/disable), cost-center +
// revenue reports, and a ledger lookup by reference. Backed by /api/finance/*.
import { pageHeader, card, table, statusBadge, btn, tabs, field, selectField, modal, sectionTitle, definitionList, loading, errorState, infoBanner } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { money, num, dash, titleCase } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

const CC_TYPES = ['DEPARTMENT', 'OUTLET', 'PROJECT', 'OVERHEAD', 'OTHER'];

export function FinanceView({ services, session }) {
  const principal = session.getPrincipal();
  const canWrite = can(principal, 'cost_center.write');
  const canLedger = can(principal, 'ledger.read');
  let active = 'cost_centers';

  const sections = {
    cost_centers(el) {
      el.innerHTML = loading();
      services.finance.costCenters({}).then((res) => {
        el.innerHTML = card(table([
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type', render: (r) => titleCase(r.type) },
          { key: 'is_active', label: 'Status', render: (r) => statusBadge(r.is_active ? 'OPEN' : 'CLOSED') },
          { label: 'Action', render: (r) => (canWrite && r.is_active ? btn('Disable', { action: 'cc-disable', id: r.id, variant: 'ghost', icon: 'block' }) : '') }
        ], asArray(res), { empty: 'No cost centers' }));
      }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Failed to load'); });
    },
    reports(el) {
      el.innerHTML = '<div id="rep-cc" class="mb-6"></div><div id="rep-rev"></div>';
      services.finance.reportCostCenter({}).then((res) => {
        const rows = asArray(res);
        el.querySelector('#rep-cc').innerHTML = card(sectionTitle('Cost-centre report') + table([
          { key: 'cost_center_id', label: 'Cost centre', render: (x) => dash(x.cost_center_id) },
          { key: 'debit', label: 'Debit', render: (x) => money(x.debit) },
          { key: 'credit', label: 'Credit', render: (x) => money(x.credit) }
        ], rows, { empty: 'No ledger activity' }));
      }).catch((e) => { el.querySelector('#rep-cc').innerHTML = errorState((e && e.message) || 'Report unavailable'); });
      services.finance.reportRevenue({}).then((res) => {
        const o = asObject(res);
        el.querySelector('#rep-rev').innerHTML = card(sectionTitle('Revenue summary') + definitionList(
          Object.entries(o).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [titleCase(k), /revenue|total|amount/i.test(k) ? money(v) : String(v)])));
      }).catch(() => { el.querySelector('#rep-rev').innerHTML = ''; });
    },
    ledger(el) {
      el.innerHTML = card(infoBanner('Look up ledger entries by their source reference (e.g. reference_type=invoice and the reference id).', 'account_tree')
        + `<form id="led-form" class="flex flex-wrap items-end gap-3">
            ${field({ name: 'reference_type', label: 'Reference type', placeholder: 'invoice / folio …' })}
            ${field({ name: 'reference_id', label: 'Reference id' })}
            <div>${btn('Look up', { action: 'led-go', icon: 'search' })}</div>
          </form><div id="led-result" class="mt-5"></div>`);
    }
  };

  function openCreateCC(outlet) {
    openOverlay(modal({ id: 'cc', title: 'New Cost Centre', body: `<form id="ccf" class="space-y-4">
      ${field({ name: 'code', label: 'Code', required: true })}
      ${field({ name: 'name', label: 'Name', required: true })}
      ${selectField({ name: 'type', label: 'Type', placeholder: '', value: 'DEPARTMENT', options: CC_TYPES.map((t) => ({ value: t, label: titleCase(t) })) })}
    </form>`, footer: `${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Create', { action: 'cc-go', icon: 'add' })}` }), (root) => {
      on(root, '[data-action="cc-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(root.querySelector('#ccf')).entries());
        if (!d.code || !d.name) { toast('Code and name required', 'error'); return; }
        try { await services.finance.createCostCenter(d); toast('Cost centre created', 'success'); closeOverlay(); sections.cost_centers(outlet.querySelector('#fin-body')); }
        catch (e) { toast((e && e.message) || 'Create failed', 'error'); }
      });
    });
  }

  function renderActive(outlet) {
    const t = [{ id: 'cost_centers', label: 'Cost Centres' }, { id: 'reports', label: 'Reports' }];
    if (canLedger) t.push({ id: 'ledger', label: 'Ledger' });
    outlet.querySelector('#fin-tabs').innerHTML = tabs(t, active);
    (sections[active] || sections.cost_centers)(outlet.querySelector('#fin-body'));
  }

  return {
    render(outlet) {
      const actions = canWrite ? btn('New Cost Centre', { action: 'cc-new', icon: 'add' }) : '';
      outlet.innerHTML = pageHeader('Accounting', 'Cost centres, reports & general ledger', actions)
        + '<div id="fin-tabs"></div><div id="fin-body"></div>';
      renderActive(outlet);
      on(outlet, '[data-tab]', 'click', (e, t) => { active = t.getAttribute('data-tab'); renderActive(outlet); });
      on(outlet, '[data-action="led-go"]', 'click', async (e) => {        // bound once (delegated)
        e.preventDefault();
        const rt = (outlet.querySelector('[name="reference_type"]') || {}).value;
        const ri = (outlet.querySelector('[name="reference_id"]') || {}).value;
        if (!rt || !ri) { toast('Reference type and id required', 'error'); return; }
        const r = outlet.querySelector('#led-result'); if (r) r.innerHTML = loading();
        try {
          const rows = asArray(await services.finance.ledgerByReference({ reference_type: rt, reference_id: ri }));
          if (r) r.innerHTML = table([
            { key: 'account_code', label: 'Account', render: (x) => dash(x.account_code) },
            { key: 'debit_amount', label: 'Debit', render: (x) => money(x.debit_amount) },
            { key: 'credit_amount', label: 'Credit', render: (x) => money(x.credit_amount) },
            { key: 'entry_type', label: 'Type', render: (x) => dash(x.entry_type) }
          ], rows, { empty: 'No ledger entries for this reference' });
        } catch (err) { if (r) r.innerHTML = `<p class="text-error text-sm">${(err && err.message) || 'Lookup failed'}</p>`; }
      });
      on(outlet, '[data-action="cc-new"]', 'click', () => openCreateCC(outlet));
      on(outlet, '[data-action="cc-disable"]', 'click', async (e, t) => { try { await services.finance.disableCostCenter(t.getAttribute('data-id')); toast('Disabled', 'success'); sections.cost_centers(outlet.querySelector('#fin-body')); } catch (err) { toast((err && err.message) || 'Failed', 'error'); } });
    }
  };
}
