// Top bar (Stitch): notifications / help icons + signed-in principal + roles.
import { esc } from '../utils/dom.js';

export function topbar({ principal }) {
  const roles = ((principal && principal.roles) || []).join(', ') || 'guest';
  const userId = (principal && principal.userId) || 'user';
  const icon = (name) => `<span class="material-symbols-outlined text-on-surface-variant cursor-pointer p-2 hover:bg-surface-container rounded-lg transition-colors">${name}</span>`;
  return `<header class="h-16 bg-surface border-b border-outline-variant/40 flex items-center justify-between px-8 sticky top-0 z-30">
    <div class="flex items-center gap-2 text-slate text-sm"><span class="material-symbols-outlined text-lg text-primary">apartment</span><span class="font-display font-semibold">QYRVIA ERP</span></div>
    <div class="flex items-center gap-2">
      <div class="relative">${icon('notifications')}<span class="absolute top-2 right-2 w-2 h-2 bg-primary rounded-full"></span></div>
      ${icon('help')}
      <div class="h-8 w-px bg-outline-variant/40 mx-2"></div>
      <div class="text-right"><p class="text-sm font-medium text-on-surface">${esc(userId)}</p><p class="text-xs text-slate uppercase tracking-tight">${esc(roles)}</p></div>
      <div class="w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center font-medium">${esc(String(userId).slice(0, 1).toUpperCase())}</div>
    </div></header>`;
}
