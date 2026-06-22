// App shell: sidebar + topbar + content outlet. Returns the outlet element so
// the active view can render into it. Wires nav + logout via delegation.
import { sidebar } from './Sidebar.js';
import { topbar } from './Topbar.js';
import { on } from '../utils/dom.js';

export function renderShell(appEl, { principal, activeRouteId, onNavigate, onLogout }) {
  appEl.innerHTML = `<div class="flex">
    ${sidebar({ principal, activeRouteId })}
    <div class="flex-1 min-w-0">
      ${topbar({ principal })}
      <main id="outlet" class="p-8 max-w-7xl mx-auto"></main>
    </div></div>`;

  on(appEl, '[data-nav]', 'click', (e, t) => { e.preventDefault(); onNavigate('/' + t.getAttribute('data-nav')); });
  on(appEl, '[data-action="logout"]', 'click', () => onLogout());
  return appEl.querySelector('#outlet');
}
