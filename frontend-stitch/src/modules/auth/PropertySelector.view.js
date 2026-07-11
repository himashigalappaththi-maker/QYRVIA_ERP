// Phase 57: Property selection screen shown when a user has access to multiple
// properties and requires_property_selection=true from the server.
import { on, qs } from '../../utils/dom.js';
import { toast } from '../../components/Toast.js';

export function PropertySelectorView({ services, session, navigate }) {
  return {
    render(appEl) {
      const s = session.get();
      const properties = (s && s.authorisedProperties) || [];

      if (!properties.length) {
        navigate('/dashboard');
        return;
      }

      const propertyItems = properties.map((p) => `
        <button type="button" data-property-id="${p.id}"
          class="w-full text-left rounded-lg border border-outline-variant hover:border-primary px-4 py-3 text-sm transition-colors">
          <div class="font-medium">${_esc(p.name || p.code)}</div>
          ${p.code ? `<div class="text-xs text-slate">${_esc(p.code)}</div>` : ''}
        </button>`).join('');

      appEl.innerHTML = `<div class="min-h-screen flex items-center justify-center bg-background px-4">
        <div class="w-full max-w-md">
          <div class="text-center mb-8">
            <span class="material-symbols-outlined text-primary text-4xl">hotel</span>
            <h1 class="font-display text-3xl font-bold mt-2">QYRVIA</h1>
            <p class="text-slate text-sm">Select a property to continue</p>
          </div>
          <div class="card bg-surface rounded-xl shadow-card p-8 space-y-3">
            ${propertyItems}
          </div>
        </div></div>`;

      on(appEl, '[data-property-id]', 'click', async (e) => {
        const btn = e.target.closest('[data-property-id]');
        if (!btn) return;
        const propertyId = btn.dataset.propertyId;
        try {
          await services.auth.switchProperty(propertyId);
          const fresh = session.get();
          if (fresh) session.save(Object.assign({}, fresh, { principal: Object.assign({}, fresh.principal, { propertyId }) }));
          navigate('/dashboard');
        } catch (err) {
          toast((err && err.message) || 'Could not switch property', 'error');
        }
      });
    }
  };
}

function _esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
