// Top bar: page context + the signed-in principal + roles.
import { esc } from '../utils/dom.js';

export function topbar({ principal }) {
  const roles = ((principal && principal.roles) || []).join(', ') || 'guest';
  const userId = (principal && principal.userId) || 'user';
  return `<header class="h-16 bg-surface border-b border-outline-variant/50 flex items-center justify-between px-8">
    <div class="flex items-center gap-2 text-slate text-sm"><span class="material-symbols-outlined text-lg">apartment</span>QYRVIA ERP</div>
    <div class="flex items-center gap-3">
      <div class="text-right"><p class="text-sm font-medium text-on-surface">${esc(userId)}</p>
      <p class="text-xs text-slate">${esc(roles)}</p></div>
      <div class="w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center font-medium">${esc(String(userId).slice(0, 1).toUpperCase())}</div>
    </div></header>`;
}
