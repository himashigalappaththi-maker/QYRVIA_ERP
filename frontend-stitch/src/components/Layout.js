// App shell: responsive sidebar (desktop) + mobile bottom nav + topbar + content
// outlet + AI assistant launcher. Returns the outlet element for the active view.
import { sidebar } from './Sidebar.js';
import { topbar } from './Topbar.js';
import { assistantLauncherHTML, wireAssistant } from './AssistantLauncher.js';
import { navItems } from '../app/routes.js';
import { visibleNav } from '../utils/rbac.js';
import { on, esc } from '../utils/dom.js';

function mobileNav({ principal, activeRouteId }) {
  const items = visibleNav(navItems(), principal).slice(0, 5).map((r) => {
    const active = r.id === activeRouteId;
    return `<button data-nav="${esc(r.id)}" class="flex flex-col items-center justify-center ${active ? 'text-primary' : 'text-on-surface-variant'} px-2">
      <span class="material-symbols-outlined" ${active ? 'style="font-variation-settings: \'FILL\' 1;"' : ''}>${esc(r.icon || 'circle')}</span>
      <span class="text-[10px]">${esc(r.label)}</span></button>`;
  }).join('');
  return `<nav class="fixed bottom-0 left-0 w-full z-30 flex justify-around items-center px-2 py-2 bg-surface/90 backdrop-blur-md border-t border-outline-variant/30 lg:hidden">${items}</nav>`;
}

export function renderShell(appEl, { principal, activeRouteId, onNavigate, onLogout }) {
  appEl.innerHTML = `<div class="flex">
    <div class="hidden lg:block">${sidebar({ principal, activeRouteId })}</div>
    <div class="flex-1 min-w-0">
      ${topbar({ principal })}
      <main id="outlet" class="p-6 lg:p-8 pb-24 lg:pb-8 max-w-7xl mx-auto"></main>
    </div>
    ${mobileNav({ principal, activeRouteId })}
    ${assistantLauncherHTML()}
  </div>`;

  on(appEl, '[data-nav]', 'click', (e, t) => { e.preventDefault(); onNavigate('/' + t.getAttribute('data-nav')); });
  on(appEl, '[data-action="logout"]', 'click', () => onLogout());
  wireAssistant(appEl);
  return appEl.querySelector('#outlet');
}
