// Settings - typed settings catalog grouped by category, with per-key edit
// (tenant or property scope). Backed by /api/settings (schema + read/write).
import { pageHeader, card, sectionTitle, table, btn, field, selectField, modal, loading, errorState, emptyState } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, titleCase } from '../../utils/format.js';
import { asArray } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

export function SettingsView({ services, session }) {
  const canWrite = can(session.getPrincipal(), 'settings.write');

  function load(outlet) {
    const body = outlet.querySelector('#set-body');
    body.innerHTML = loading();
    services.settings.schema().then((res) => {
      const specs = asArray(res);
      if (!specs.length) { body.innerHTML = emptyState('No settings catalog registered', 'settings'); return; }
      const byCat = new Map();
      for (const s of specs) {
        const c = s.category || 'general';
        if (!byCat.has(c)) byCat.set(c, []);
        byCat.get(c).push(s);
      }
      body.innerHTML = Array.from(byCat.entries()).map(([cat, rows]) =>
        card(sectionTitle(titleCase(cat)) + table([
          { key: 'key', label: 'Key', render: (r) => `<span class="font-mono text-xs">${dash(r.key)}</span>` },
          { key: 'type', label: 'Type', render: (r) => dash(r.type || r.value_type) },
          { key: 'default', label: 'Default', render: (r) => `<span class="text-slate">${dash(fmt(r.default ?? r.default_value))}</span>` },
          { key: 'description', label: 'Description', render: (r) => dash(r.description) },
          { key: '_act', label: '', tdClass: 'text-right', render: (r) => canWrite
              ? btn('Edit', { action: 's-edit', id: `${r.category}::${r.key}`, variant: 'ghost', icon: 'edit' }) : '' }
        ], rows, { empty: 'No keys' }), 'mb-5')
      ).join('');
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load settings'); });
  }

  function openEdit(outlet, category, key) {
    openOverlay(modal({ id: 'sedit', title: `Edit ${category} / ${key}`, body: `<div id="sedit-body">${loading()}</div>` }), async (root) => {
      const el = root.querySelector('#sedit-body');
      let current = '';
      try { const r = await services.settings.get(category, key); current = r && r.value != null ? (typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value)) : ''; }
      catch (_) { /* no current value yet */ }
      el.innerHTML = `<form id="sform" class="space-y-4">
        ${field({ name: 'value', label: 'Value', value: current, placeholder: 'New value (JSON allowed)' })}
        ${selectField({ name: 'scope', label: 'Scope', value: 'tenant', placeholder: '', options: [{ value: 'tenant', label: 'Tenant (all properties)' }, { value: 'property', label: 'Current property' }] })}
        <div class="flex justify-end gap-2 pt-2">
          ${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Save', { action: 'sedit-go', icon: 'save' })}</div>
      </form>`;
      on(el, '[data-action="sedit-go"]', 'click', async () => {
        const d = Object.fromEntries(new FormData(el.querySelector('#sform')).entries());
        let value = d.value;
        try { value = JSON.parse(d.value); } catch (_) { /* keep as string */ }
        try { await services.settings.set(category, key, value, d.scope); toast('Setting saved', 'success'); closeOverlay(); load(outlet); }
        catch (e) { toast((e && e.message) || 'Save failed', 'error'); }
      });
    });
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Settings', 'Typed configuration catalog') + `<div id="set-body"></div>`;
      load(outlet);
      on(outlet, '[data-action="s-edit"]', 'click', (e, t) => {
        const [cat, key] = (t.getAttribute('data-id') || '').split('::');
        if (cat && key) openEdit(outlet, cat, key);
      });
    }
  };
}

function fmt(v) { return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); }
