// Multi-property switcher. Lists the properties the signed-in user can access
// (GET /auth/properties) and re-scopes the session to the chosen one
// (POST /auth/switch-property -> fresh access/refresh tokens). Preserves the
// multi-property context the backend issues per token.
import { openOverlay, closeOverlay } from './overlay.js';
import { drawer, emptyState, loading } from './ui.js';
import { toast } from './Toast.js';
import { asArray } from '../utils/normalize.js';
import { esc, on } from '../utils/dom.js';

export function openPropertySwitcher({ services, session, onSwitched }) {
  openOverlay(drawer({ id: 'prop', title: 'Switch Property', body: `<div id="prop-list">${loading()}</div>` }), async (root) => {
    const listEl = root.querySelector('#prop-list');
    try {
      const rows = asArray(await services.auth.properties());
      const cur = (session.getPrincipal() || {}).propertyId;
      listEl.innerHTML = rows.length ? rows.map((p) => {
        const id = p.id || p.property_id;
        const code = p.code || '';
        const name = p.name || code || id;
        const active = id === cur;
        return `<button data-prop="${esc(id)}" data-code="${esc(code)}" class="w-full text-left flex items-center justify-between px-4 py-3 rounded-lg mb-1 ${active ? 'bg-primary-container/30' : 'hover:bg-surface-container'}">
          <span><span class="font-medium">${esc(name)}</span><span class="block text-xs text-slate">${esc(code)}${(p.role_codes || []).length ? ' · ' + esc((p.role_codes || []).join(', ')) : ''}</span></span>
          ${active ? '<span class="material-symbols-outlined text-primary">check</span>' : ''}</button>`;
      }).join('') : emptyState('No accessible properties');

      on(listEl, '[data-prop]', 'click', async (e, t) => {
        const id = t.getAttribute('data-prop');
        const code = t.getAttribute('data-code');
        try {
          const r = await services.auth.switchProperty(id) || {};
          const s = session.load() || {};
          if (r.access_token || r.token) s.token = r.access_token || r.token;
          if (r.refresh_token) s.refreshToken = r.refresh_token;
          if (r.access_expires_at) { const t2 = Date.parse(r.access_expires_at); if (!Number.isNaN(t2)) s.expiresAt = t2; }
          s.principal = Object.assign({}, s.principal, { propertyId: id, propertyCode: code });
          session.save(s);
          toast('Switched to ' + (code || 'property'), 'success');
          closeOverlay();
          if (onSwitched) onSwitched();
        } catch (err) { toast((err && err.message) || 'Switch failed', 'error'); }
      });
    } catch (err) {
      listEl.innerHTML = emptyState((err && err.message) || 'Could not load properties', 'error');
    }
  });
}
