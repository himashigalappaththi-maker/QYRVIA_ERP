// Reusable Stitch-styled UI primitives (return HTML strings).
import { esc } from '../utils/dom.js';

export function pageHeader(title, subtitle, actionsHtml = '') {
  return `<div class="flex items-end justify-between mb-6">
    <div><h1 class="font-display text-3xl font-bold text-on-surface">${esc(title)}</h1>
    ${subtitle ? `<p class="text-slate text-sm mt-1">${esc(subtitle)}</p>` : ''}</div>
    <div class="flex gap-3">${actionsHtml}</div></div>`;
}

export function card(inner, extraClass = '') {
  return `<div class="card bg-surface rounded-xl shadow-card p-6 ${extraClass}">${inner}</div>`;
}

export function kpiCard({ label, value, icon }) {
  return card(`<div class="flex items-center justify-between">
    <div><p class="text-slate text-xs uppercase tracking-wider">${esc(label)}</p>
    <p class="font-display text-2xl font-bold mt-1">${esc(value)}</p></div>
    ${icon ? `<span class="material-symbols-outlined text-primary text-3xl">${esc(icon)}</span>` : ''}</div>`);
}

export function statusBadge(status) {
  const s = String(status || '').toUpperCase();
  const map = {
    OPEN: 'bg-primary-container/40 text-on-primary-container', READY: 'bg-success/15 text-success',
    CLEAN: 'bg-success/15 text-success', INSPECTED: 'bg-success/15 text-success',
    DIRTY: 'bg-error-container text-error', CLEANING: 'bg-primary-container/40 text-on-primary-container',
    OCCUPIED: 'bg-charcoal/10 text-charcoal', CONFIRMED: 'bg-success/15 text-success',
    CANCELLED: 'bg-error-container text-error', AUDIT_PENDING: 'bg-error-container text-error',
    CLOSED: 'bg-charcoal/10 text-charcoal', FINAL: 'bg-success/15 text-success', PROFORMA: 'bg-primary-container/40 text-on-primary-container'
  };
  const cls = map[s] || 'bg-surface-container text-on-surface-variant';
  return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}">${esc(s || '—')}</span>`;
}

export function table(columns, rows, { empty = 'No records' } = {}) {
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  if (!rows || rows.length === 0) {
    return `<table class="qy-table w-full"><thead><tr>${head}</tr></thead>
      <tbody><tr><td colspan="${columns.length}" class="text-center text-slate py-8">${esc(empty)}</td></tr></tbody></table>`;
  }
  const body = rows.map((r) => '<tr>' + columns.map((c) => `<td>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('') + '</tr>').join('');
  return `<table class="qy-table w-full"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function btn(label, { action, variant = 'primary', icon } = {}) {
  const styles = {
    primary: 'bg-primary text-on-primary hover:shadow-card',
    secondary: 'bg-charcoal text-white hover:opacity-90',
    ghost: 'bg-transparent text-charcoal border border-outline-variant hover:bg-surface-container'
  };
  return `<button ${action ? `data-action="${esc(action)}"` : ''} class="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${styles[variant] || styles.primary}">
    ${icon ? `<span class="material-symbols-outlined text-base">${esc(icon)}</span>` : ''}${esc(label)}</button>`;
}

export function loading() { return `<div class="flex items-center justify-center py-16 text-slate"><span class="material-symbols-outlined animate-spin">progress_activity</span><span class="ml-2">Loading…</span></div>`; }
export function errorState(message) { return card(`<div class="text-center py-10"><span class="material-symbols-outlined text-error text-4xl">error</span><p class="mt-2 text-on-surface-variant">${esc(message)}</p></div>`); }
