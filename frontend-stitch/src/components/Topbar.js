// Top bar (Stitch): mobile menu button, multi-property switcher, signed-in
// principal + roles. The property switcher reflects the active property context
// and opens the live property picker (backed by /auth/properties + /switch-property).
import { esc } from '../utils/dom.js';

export function topbar({ principal }) {
  const roles = ((principal && principal.roles) || []).join(', ') || 'guest';
  const userId = (principal && principal.userId) || 'user';
  const propLabel = (principal && (principal.propertyCode || principal.propertyId)) || 'Select property';
  return `<header class="h-16 bg-surface border-b border-outline-variant/40 flex items-center justify-between px-4 sm:px-8 sticky top-0 z-30">
    <div class="flex items-center gap-2">
      <button data-action="open-mobile-nav" class="lg:hidden material-symbols-outlined text-on-surface-variant p-2 -ml-2">menu</button>
      <button data-action="open-property-switcher" class="flex items-center gap-2 text-slate text-sm rounded-lg px-2.5 py-1.5 hover:bg-surface-container transition-colors">
        <span class="material-symbols-outlined text-lg text-primary">apartment</span>
        <span class="font-display font-semibold text-on-surface max-w-[160px] truncate">${esc(propLabel)}</span>
        <span class="material-symbols-outlined text-base text-slate">expand_more</span>
      </button>
    </div>
    <div class="flex items-center gap-2">
      <div class="hidden sm:block text-right"><p class="text-sm font-medium text-on-surface">${esc(userId)}</p><p class="text-xs text-slate uppercase tracking-tight max-w-[200px] truncate">${esc(roles)}</p></div>
      <div class="w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center font-medium">${esc(String(userId).slice(0, 1).toUpperCase())}</div>
    </div></header>`;
}
