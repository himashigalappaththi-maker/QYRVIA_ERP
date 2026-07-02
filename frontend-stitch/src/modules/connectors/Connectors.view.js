// Connectors - list registered connector types, configure (enable + JSON config),
// and run probe / health checks. Backed by /api/connectors.
import { pageHeader, card, table, statusBadge, btn, field, textareaField, modal, loading, errorState } from '../../components/ui.js';
import { openOverlay, closeOverlay } from '../../components/overlay.js';
import { toast } from '../../components/Toast.js';
import { on } from '../../utils/dom.js';
import { dash, titleCase } from '../../utils/format.js';
import { asArray, asObject } from '../../utils/normalize.js';
import { can } from '../../utils/rbac.js';

export function ConnectorsView({ services, session }) {
  const canConfigure = can(session.getPrincipal(), 'connector.configure');

  function load(outlet) {
    const body = outlet.querySelector('#c-body');
    body.innerHTML = loading();
    services.connectors.list().then((res) => {
      body.innerHTML = card(table([
        { key: 'code', label: 'Code', render: (r) => `<span class="font-mono text-xs">${dash(r.code)}</span>` },
        { key: 'label', label: 'Label', render: (r) => dash(r.label) },
        { key: 'type', label: 'Type', render: (r) => titleCase(r.type) },
        { key: 'is_active', label: 'Active', render: (r) => statusBadge(r.is_active === false ? 'CLOSED' : 'OPEN') },
        { key: '_act', label: '', tdClass: 'text-right', render: (r) => (canConfigure ? [
            btn('Configure', { action: 'c-config', id: r.code, variant: 'ghost', icon: 'tune' }),
            btn('Probe', { action: 'c-probe', id: r.code, variant: 'ghost', icon: 'sensors' }),
            btn('Health', { action: 'c-health', id: r.code, variant: 'ghost', icon: 'health_and_safety' })
          ].join('') : '') }
      ], asArray(res), { empty: 'No connectors registered' }));
    }).catch((e) => { body.innerHTML = errorState((e && e.message) || 'Failed to load connectors'); });
  }

  function openConfig(outlet, code) {
    openOverlay(modal({ id: 'ccfg', title: 'Configure ' + code, size: 'max-w-xl', body: `<div id="ccfg-body">${loading()}</div>` }), async (root) => {
      const el = root.querySelector('#ccfg-body');
      let cfg = {};
      try { cfg = asObject(await services.connectors.config(code)); } catch (_) { /* none yet */ }
      const cfgJson = cfg && cfg.config_json ? JSON.stringify(cfg.config_json, null, 2) : '{}';
      el.innerHTML = `<form id="ccform" class="space-y-4">
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" ${cfg && cfg.enabled ? 'checked' : ''} /> Enabled</label>
        ${textareaField({ name: 'config_json', label: 'Config (JSON)', value: cfgJson, rows: 8 })}
        <div class="flex justify-end gap-2 pt-2">${btn('Cancel', { action: 'modal-close', variant: 'ghost' })}${btn('Save', { action: 'ccfg-go', icon: 'save' })}</div>
      </form>`;
      on(el, '[data-action="ccfg-go"]', 'click', async () => {
        const form = el.querySelector('#ccform');
        let config_json = {};
        try { config_json = JSON.parse(form.querySelector('[name="config_json"]').value || '{}'); }
        catch (_) { toast('Config must be valid JSON', 'error'); return; }
        const body = { enabled: form.querySelector('[name="enabled"]').checked, config_json };
        try { await services.connectors.configure(code, body); toast('Connector configured', 'success'); closeOverlay(); load(outlet); }
        catch (e) { toast((e && e.message) || 'Save failed', 'error'); }
      });
    });
  }

  return {
    render(outlet) {
      outlet.innerHTML = pageHeader('Connectors', 'Integration connector registry') + `<div id="c-body"></div>`;
      load(outlet);
      on(outlet, '[data-action="c-config"]', 'click', (e, t) => openConfig(outlet, t.getAttribute('data-id')));
      on(outlet, '[data-action="c-probe"]', 'click', async (e, t) => {
        try { const r = await services.connectors.probe(t.getAttribute('data-id')); toast('Probe: ' + (r && (r.status || 'ok')), 'success'); }
        catch (err) { toast((err && err.message) || 'Probe failed', 'error'); }
      });
      on(outlet, '[data-action="c-health"]', 'click', async (e, t) => {
        try { const r = await services.connectors.health(t.getAttribute('data-id')); toast('Health: ' + (r && (r.status || 'ok')), 'success'); }
        catch (err) { toast((err && err.message) || 'Health check failed', 'error'); }
      });
    }
  };
}
