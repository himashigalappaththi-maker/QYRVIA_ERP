// Charcoal sidebar (Stitch "Enterprise Suite" treatment): branded header,
// gold active indicator + filled active icon, RBAC-filtered nav, footer actions.
import { esc } from '../utils/dom.js';
import { navItems } from '../app/routes.js';
import { visibleNav } from '../utils/rbac.js';

export function sidebar({ principal, activeRouteId }) {
  const items = visibleNav(navItems(), principal).map((r) => {
    const active = r.id === activeRouteId;
    return `<a href="#${esc(r.path)}" data-nav="${esc(r.id)}"
       class="nav-item ${active ? 'active text-white' : 'text-white/70 hover:text-white hover:bg-white/5'} flex items-center gap-3 px-5 py-3 text-sm font-medium transition-colors">
      <span class="material-symbols-outlined text-xl" ${active ? 'style="font-variation-settings: \'FILL\' 1;"' : ''}>${esc(r.icon || 'circle')}</span>${esc(r.label)}
    </a>`;
  }).join('');

  return `<aside class="w-[280px] shrink-0 bg-charcoal min-h-screen flex flex-col">
    <div class="px-6 py-7 flex items-center gap-3">
      <img src="./assets/qyrvia-logo.png" alt="QYRVIA" class="w-10 h-10 rounded-lg bg-white/5 object-contain p-1" onerror="this.style.display='none'" />
      <div>
        <h1 class="font-display text-xl font-bold text-white leading-tight">QYRVIA</h1>
        <p class="text-[10px] text-primary-container uppercase tracking-widest">Enterprise Suite</p>
      </div>
    </div>
    <nav class="flex-1 px-2 space-y-0.5">${items}</nav>
    <div class="px-2 py-4 border-t border-white/10">
      <button data-action="logout" class="nav-item w-full text-white/70 hover:text-white hover:bg-white/5 flex items-center gap-3 px-5 py-3 text-sm font-medium transition-colors">
        <span class="material-symbols-outlined text-xl">logout</span>Logout</button>
    </div></aside>`;
}
