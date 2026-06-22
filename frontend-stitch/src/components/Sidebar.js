// Charcoal sidebar with gold active indicator. Nav is RBAC-filtered (UX only).
import { esc } from '../utils/dom.js';
import { navItems } from '../app/routes.js';
import { visibleNav } from '../utils/rbac.js';

export function sidebar({ principal, activeRouteId }) {
  const items = visibleNav(navItems(), principal).map((r) => `
    <a href="#${esc(r.path)}" data-nav="${esc(r.id)}"
       class="nav-item ${r.id === activeRouteId ? 'active text-white' : 'text-white/70 hover:text-white'} flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium">
      <span class="material-symbols-outlined text-xl">${esc(r.icon || 'circle')}</span>${esc(r.label)}
    </a>`).join('');

  return `<aside class="w-[280px] shrink-0 bg-charcoal min-h-screen flex flex-col">
    <div class="px-6 py-6 flex items-center gap-2">
      <span class="material-symbols-outlined text-primary-container text-2xl">hotel</span>
      <span class="font-display text-xl font-bold text-white tracking-tight">QYRVIA</span>
    </div>
    <nav class="flex-1 px-3 space-y-1">${items}</nav>
    <div class="px-3 py-4 border-t border-white/10">
      <button data-action="logout" class="nav-item w-full text-white/70 hover:text-white flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium">
        <span class="material-symbols-outlined text-xl">logout</span>Logout</button>
    </div></aside>`;
}
