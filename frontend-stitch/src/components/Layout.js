// App shell: responsive sidebar (desktop) + mobile top-menu drawer + bottom nav
// + topbar (with multi-property switcher) + content outlet + assistant launcher.
// Returns the outlet element for the active view.
import { sidebar, navTree } from './Sidebar.js';
import { topbar } from './Topbar.js';
import { assistantLauncherHTML, wireAssistant } from './AssistantLauncher.js';
import { navItems } from '../app/routes.js';
import { visibleNav } from '../utils/rbac.js';
import { openOverlay, closeOverlay } from './overlay.js';
import { on, esc } from '../utils/dom.js';

function mobileBottomNav({ principal, activeRouteId }) {
  const items = visibleNav(navItems(), principal).slice(0, 4).map((r) => {
    const active = r.id === activeRouteId;
    return `<button data-nav="${esc(r.id)}" class="flex flex-col items-center justify-center ${active ? 'text-primary' : 'text-on-surface-variant'} px-2">
      <span class="material-symbols-outlined" ${active ? 'style="font-variation-settings: \'FILL\' 1;"' : ''}>${esc(r.icon || 'circle')}</span>
      <span class="text-[10px]">${esc(r.label)}</span></button>`;
  }).join('');
  return `<nav class="fixed bottom-0 left-0 w-full z-30 flex justify-around items-center px-2 py-2 bg-surface/95 backdrop-blur-md border-t border-outline-variant/30 lg:hidden">
    ${items}
    <button data-action="open-mobile-nav" class="flex flex-col items-center justify-center text-on-surface-variant px-2">
      <span class="material-symbols-outlined">menu</span><span class="text-[10px]">More</span></button>
  </nav>`;
}

export function renderShell(appEl, { principal, activeRouteId, onNavigate, onLogout, onOpenPropertySwitcher }) {
  appEl.innerHTML = `<div class="flex">
    <div class="hidden lg:block">${sidebar({ principal, activeRouteId })}</div>
    <div class="flex-1 min-w-0">
      ${topbar({ principal })}
      <main id="outlet" class="p-4 sm:p-6 lg:p-8 pb-24 lg:pb-8 max-w-7xl mx-auto"></main>
    </div>
    ${mobileBottomNav({ principal, activeRouteId })}
    ${assistantLauncherHTML()}
  </div>`;

  on(appEl, '[data-nav]', 'click', (e, t) => { e.preventDefault(); onNavigate('/' + t.getAttribute('data-nav')); });
  on(appEl, '[data-action="logout"]', 'click', () => onLogout());
  on(appEl, '[data-action="open-property-switcher"]', 'click', () => onOpenPropertySwitcher && onOpenPropertySwitcher());
  on(appEl, '[data-action="open-mobile-nav"]', 'click', () => {
    openOverlay(`<div data-modal="mnav" class="fixed inset-0 z-50 flex">
      <div data-action="modal-close" class="absolute inset-0 bg-black/40"></div>
      <aside class="relative bg-charcoal w-[260px] h-full overflow-y-auto">
        <div class="px-6 py-6"><h1 class="font-display text-xl font-bold text-white">QYRVIA</h1></div>
        <nav class="px-2 pb-6 space-y-0.5">${navTree({ principal, activeRouteId })}</nav>
      </aside></div>`, (root) => {
      on(root, '[data-nav]', 'click', (e, t) => { e.preventDefault(); closeOverlay(); onNavigate('/' + t.getAttribute('data-nav')); });
    });
  });
  wireAssistant(appEl);
  return appEl.querySelector('#outlet');
}
