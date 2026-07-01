// Charcoal sidebar (Stitch "Enterprise Suite"): branded header, gold active
// indicator + filled active icon, RBAC-filtered + section-grouped nav, footer.
import { esc } from '../utils/dom.js';
import { navItems, navSections } from '../app/routes.js';
import { visibleNav } from '../utils/rbac.js';

function navLink(r, activeRouteId) {
  const active = r.id === activeRouteId;
  return `<a href="#${esc(r.path)}" data-nav="${esc(r.id)}"
     class="nav-item ${active ? 'active text-white' : 'text-white/70 hover:text-white hover:bg-white/5'} flex items-center gap-3 px-5 py-2.5 text-sm font-medium transition-colors">
    <span class="material-symbols-outlined text-xl" ${active ? 'style="font-variation-settings: \'FILL\' 1;"' : ''}>${esc(r.icon || 'circle')}</span>${esc(r.label)}
  </a>`;
}

export function navTree({ principal, activeRouteId }) {
  const visible = visibleNav(navItems(), principal);
  return navSections(visible).map((grp) => {
    const links = grp.items.map((r) => navLink(r, activeRouteId)).join('');
    const header = grp.section === 'Overview' ? '' :
      `<p class="px-5 pt-4 pb-1 text-[10px] font-bold uppercase tracking-widest text-white/25">${esc(grp.section)}</p>`;
    return header + links;
  }).join('');
}

export function sidebar({ principal, activeRouteId }) {
  return `<aside class="w-[260px] shrink-0 bg-charcoal min-h-screen flex flex-col">
    <div class="px-6 py-6 flex items-center gap-3">
      <img src="./assets/qyrvia-logo.png" alt="QYRVIA" class="w-10 h-10 rounded-lg bg-white/5 object-contain p-1" onerror="this.style.display='none'" />
      <div>
        <h1 class="font-display text-xl font-bold text-white leading-tight">QYRVIA</h1>
        <p class="text-[10px] text-primary-container uppercase tracking-widest">Enterprise Suite</p>
      </div>
    </div>
    <nav class="flex-1 px-2 pb-4 space-y-0.5 overflow-y-auto">${navTree({ principal, activeRouteId })}</nav>
    <div class="px-2 py-4 border-t border-white/10">
      <button data-action="logout" class="nav-item w-full text-white/70 hover:text-white hover:bg-white/5 flex items-center gap-3 px-5 py-3 text-sm font-medium transition-colors">
        <span class="material-symbols-outlined text-xl">logout</span>Logout</button>
    </div></aside>`;
}
