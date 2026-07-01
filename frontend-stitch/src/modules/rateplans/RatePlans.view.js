// Rate Plans - list rate plans with a detail drawer (periods + pricing) and a
// Meal Plans tab. Backed by /api/pms/rate-plans + /meal-plans.
import { pageHeader, card, table, btn, tabs, drawer, definitionList, sectionTitle, loading, errorState } from '../../components/ui.js';
import { openOverlay } from '../../components/overlay.js';
import { on } from '../../utils/dom.js';
import { money, dash } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';

export function RatePlansView({ services }) {
  let active = 'plans';

  const sections = {
    plans(el) {
      el.innerHTML = loading();
      services.ratePlans.list().then((res) => {
        el.innerHTML = card(table([
          { key: 'code', label: 'Code', render: (r) => `<button data-rp="${r.id}" class="text-primary font-medium hover:underline">${dash(r.code)}</button>` },
          { key: 'name', label: 'Name' },
          { key: 'currency', label: 'Currency', render: (r) => dash(r.currency) },
          { key: 'base_rate', label: 'Base rate', render: (r) => money(r.base_rate, r.currency) },
          { key: 'active', label: 'Active', render: (r) => (r.active ? 'Yes' : 'No') }
        ], asArray(res), { empty: 'No rate plans' }));
      }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Failed to load'); });
    },
    meals(el) {
      el.innerHTML = loading();
      services.mealPlans.list().then((res) => {
        el.innerHTML = card(table([
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'description', label: 'Description', render: (r) => dash(r.description) }
        ], asArray(res), { empty: 'No meal plans' }));
      }).catch((e) => { el.innerHTML = errorState((e && e.message) || 'Failed to load'); });
    }
  };

  function openPlan(id) {
    openOverlay(drawer({ id: 'rp', title: 'Rate Plan', body: `<div id="rp-detail">${loading()}</div>` }), async (root) => {
      const el = root.querySelector('#rp-detail');
      let p;
      try { p = asObject(await services.ratePlans.byId(id)); } catch (e) { el.innerHTML = `<p class="text-error text-sm">${(e && e.message) || 'Failed'}</p>`; return; }
      const periods = asArray(p.periods);
      const pricing = asArray(p.pricing);
      el.innerHTML = definitionList([
        ['Code', dash(p.code)], ['Name', dash(p.name)], ['Currency', dash(p.currency)], ['Base rate', money(p.base_rate, p.currency)]
      ]) + (periods.length ? sectionTitle('Periods') + table([
        { key: 'name', label: 'Name', render: (x) => dash(x.name) }, { key: 'date_from', label: 'From' }, { key: 'date_to', label: 'To' }, { key: 'rate', label: 'Rate', render: (x) => money(x.rate, p.currency) }
      ], periods, { empty: 'No periods' }) : '')
      + (pricing.length ? sectionTitle('Pricing') + table([
        { key: 'pricing_type', label: 'Type' }, { key: 'occupancy_count', label: 'Occ' }, { key: 'rate', label: 'Rate', render: (x) => money(x.rate, p.currency) }
      ], pricing, { empty: 'No pricing rows' }) : '');
    });
  }

  function renderActive(outlet) {
    outlet.querySelector('#rp-tabs').innerHTML = tabs([{ id: 'plans', label: 'Rate Plans' }, { id: 'meals', label: 'Meal Plans' }], active);
    (sections[active] || sections.plans)(outlet.querySelector('#rp-body'));
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Rate Plans', 'Pricing plans, periods & meal plans') + '<div id="rp-tabs"></div><div id="rp-body"></div>';
      renderActive(outlet);
      on(outlet, '[data-tab]', 'click', (e, t) => { active = t.getAttribute('data-tab'); renderActive(outlet); });
      on(outlet, '[data-rp]', 'click', (e, t) => openPlan(t.getAttribute('data-rp')));
    }
  };
}
