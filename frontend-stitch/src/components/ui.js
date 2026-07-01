// Reusable Stitch-styled UI primitives (return HTML strings). Mobile-responsive
// by default: tables scroll horizontally, modals go full-bleed on small screens.
import { esc } from '../utils/dom.js';

export function pageHeader(title, subtitle, actionsHtml = '') {
  return `<div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
    <div><h1 class="font-display text-2xl sm:text-3xl font-bold text-on-surface">${esc(title)}</h1>
    ${subtitle ? `<p class="text-slate text-sm mt-1">${esc(subtitle)}</p>` : ''}</div>
    <div class="flex flex-wrap gap-2 sm:gap-3">${actionsHtml}</div></div>`;
}

export function card(inner, extraClass = '') {
  return `<div class="card bg-surface rounded-xl shadow-card p-5 sm:p-6 ${extraClass}">${inner}</div>`;
}

export function sectionTitle(title, actionsHtml = '') {
  return `<div class="flex items-center justify-between mb-3"><h2 class="font-display text-lg font-semibold">${esc(title)}</h2><div class="flex gap-2">${actionsHtml}</div></div>`;
}

export function kpiCard({ label, value, icon, hint }) {
  return card(`<div class="flex items-center justify-between">
    <div><p class="text-slate text-xs uppercase tracking-wider">${esc(label)}</p>
    <p class="font-display text-2xl font-bold mt-1">${esc(value)}</p>
    ${hint ? `<p class="text-xs text-slate mt-0.5">${esc(hint)}</p>` : ''}</div>
    ${icon ? `<span class="material-symbols-outlined text-primary text-3xl">${esc(icon)}</span>` : ''}</div>`);
}

const BADGE_MAP = {
  OPEN: 'bg-primary-container/40 text-on-primary-container', READY: 'bg-success/15 text-success',
  CLEAN: 'bg-success/15 text-success', VACANT_CLEAN: 'bg-success/15 text-success', INSPECTED: 'bg-success/15 text-success',
  DIRTY: 'bg-error-container text-error', VACANT_DIRTY: 'bg-error-container text-error',
  CLEANING: 'bg-primary-container/40 text-on-primary-container',
  OCCUPIED: 'bg-charcoal/10 text-charcoal', CONFIRMED: 'bg-success/15 text-success',
  CHECKED_IN: 'bg-success/15 text-success', IN_HOUSE: 'bg-success/15 text-success',
  CHECKED_OUT: 'bg-charcoal/10 text-charcoal', DEPARTED: 'bg-charcoal/10 text-charcoal',
  INQUIRY: 'bg-surface-container text-on-surface-variant', OPTION: 'bg-primary-container/40 text-on-primary-container',
  CANCELLED: 'bg-error-container text-error', NO_SHOW: 'bg-error-container text-error',
  AUDIT_PENDING: 'bg-error-container text-error', PENDING: 'bg-primary-container/40 text-on-primary-container',
  ASSIGNED: 'bg-primary-container/40 text-on-primary-container', COMPLETED: 'bg-success/15 text-success',
  CLOSED: 'bg-charcoal/10 text-charcoal', FINAL: 'bg-success/15 text-success', ISSUED: 'bg-success/15 text-success',
  VOIDED: 'bg-error-container text-error', PROFORMA: 'bg-primary-container/40 text-on-primary-container',
  OUT_OF_ORDER: 'bg-error-container text-error', OUT_OF_SERVICE: 'bg-error-container text-error', BLOCKED: 'bg-error-container text-error'
};
export function statusBadge(status) {
  const s = String(status || '').toUpperCase();
  const cls = BADGE_MAP[s] || 'bg-surface-container text-on-surface-variant';
  return `<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}">${esc(String(status || '—').replace(/_/g, ' '))}</span>`;
}

export function table(columns, rows, { empty = 'No records' } = {}) {
  const head = columns.map((c) => `<th class="${c.thClass || ''}">${esc(c.label)}</th>`).join('');
  let body;
  if (!rows || rows.length === 0) {
    body = `<tr><td colspan="${columns.length}" class="text-center text-slate py-8">${esc(empty)}</td></tr>`;
  } else {
    body = rows.map((r) => '<tr>' + columns.map((c) => `<td class="${c.tdClass || ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('') + '</tr>').join('');
  }
  return `<div class="overflow-x-auto"><table class="qy-table w-full"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function btn(label, { action, id, variant = 'primary', icon, type = 'button', extra = '' } = {}) {
  const styles = {
    primary: 'bg-primary text-on-primary hover:shadow-card',
    secondary: 'bg-charcoal text-white hover:opacity-90',
    ghost: 'bg-transparent text-charcoal border border-outline-variant hover:bg-surface-container',
    danger: 'bg-error text-white hover:opacity-90'
  };
  return `<button type="${type}" ${action ? `data-action="${esc(action)}"` : ''} ${id ? `data-id="${esc(id)}"` : ''} ${extra}
    class="inline-flex items-center gap-2 rounded-lg px-3 sm:px-4 py-2 text-sm font-medium ${styles[variant] || styles.primary}">
    ${icon ? `<span class="material-symbols-outlined text-base">${esc(icon)}</span>` : ''}${esc(label)}</button>`;
}

export function tabs(items, activeId) {
  return `<div class="flex gap-1 overflow-x-auto border-b border-outline-variant/40 mb-5">` + items.map((t) => {
    const active = t.id === activeId;
    return `<button data-tab="${esc(t.id)}" class="whitespace-nowrap px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${active ? 'border-primary text-primary' : 'border-transparent text-slate hover:text-on-surface'}">${esc(t.label)}${t.count != null ? ` <span class="ml-1 text-xs ${active ? 'text-primary' : 'text-slate'}">(${esc(t.count)})</span>` : ''}</button>`;
  }).join('') + `</div>`;
}

export function toolbar(inner) {
  return `<div class="flex flex-wrap items-end gap-3 mb-5">${inner}</div>`;
}

// ---- form fields -----------------------------------------------------------
const labelCls = 'block text-xs uppercase tracking-wider text-slate mb-1';
const inputCls = 'w-full rounded-lg border border-outline-variant focus:border-primary px-3 py-2.5 text-sm outline-none bg-surface';

export function field({ name, label, type = 'text', value = '', required = false, placeholder = '', extra = '' }) {
  return `<div><label class="${labelCls}">${esc(label)}${required ? ' *' : ''}</label>
    <input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${required ? 'required' : ''} placeholder="${esc(placeholder)}" ${extra} class="${inputCls}" /></div>`;
}

export function selectField({ name, label, options, value = '', required = false, placeholder = 'Select…' }) {
  const opts = [placeholder ? `<option value="">${esc(placeholder)}</option>` : '']
    .concat((options || []).map((o) => {
      const v = typeof o === 'object' ? o.value : o;
      const l = typeof o === 'object' ? o.label : o;
      return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`;
    })).join('');
  return `<div><label class="${labelCls}">${esc(label)}${required ? ' *' : ''}</label>
    <select name="${esc(name)}" ${required ? 'required' : ''} class="${inputCls}">${opts}</select></div>`;
}

export function textareaField({ name, label, value = '', rows = 3, placeholder = '' }) {
  return `<div><label class="${labelCls}">${esc(label)}</label>
    <textarea name="${esc(name)}" rows="${rows}" placeholder="${esc(placeholder)}" class="${inputCls}">${esc(value)}</textarea></div>`;
}

// ---- modal + drawer --------------------------------------------------------
export function modal({ id = 'modal', title, body, footer = '', size = 'max-w-lg' }) {
  return `<div data-modal="${esc(id)}" class="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
    <div data-action="modal-close" class="absolute inset-0 bg-black/40"></div>
    <div class="relative bg-surface w-full ${size} sm:rounded-2xl rounded-t-2xl shadow-modal max-h-[92vh] overflow-y-auto">
      <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant/40 sticky top-0 bg-surface">
        <h3 class="font-display text-lg font-semibold">${esc(title)}</h3>
        <button data-action="modal-close" class="material-symbols-outlined text-on-surface-variant hover:text-on-surface">close</button>
      </div>
      <div class="px-6 py-5">${body}</div>
      ${footer ? `<div class="px-6 py-4 border-t border-outline-variant/40 flex justify-end gap-2 sticky bottom-0 bg-surface">${footer}</div>` : ''}
    </div></div>`;
}

export function drawer({ id = 'drawer', title, body, footer = '' }) {
  return `<div data-modal="${esc(id)}" class="fixed inset-0 z-50 flex justify-end">
    <div data-action="modal-close" class="absolute inset-0 bg-black/40"></div>
    <div class="relative bg-surface w-full max-w-md h-full shadow-modal overflow-y-auto">
      <div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant/40 sticky top-0 bg-surface">
        <h3 class="font-display text-lg font-semibold">${esc(title)}</h3>
        <button data-action="modal-close" class="material-symbols-outlined text-on-surface-variant hover:text-on-surface">close</button>
      </div>
      <div class="px-6 py-5">${body}</div>
      ${footer ? `<div class="px-6 py-4 border-t border-outline-variant/40 flex justify-end gap-2">${footer}</div>` : ''}
    </div></div>`;
}

export function infoBanner(message, icon = 'info') {
  return `<div class="flex items-start gap-2 rounded-lg bg-primary-container/30 text-on-primary-container px-4 py-3 text-sm mb-4">
    <span class="material-symbols-outlined text-base">${esc(icon)}</span><span>${message}</span></div>`;
}

export function definitionList(pairs) {
  return `<dl class="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">` + pairs.map(([k, v]) =>
    `<dt class="text-slate col-span-1">${esc(k)}</dt><dd class="col-span-2 text-on-surface break-words">${v}</dd>`).join('') + `</dl>`;
}

export function loading() { return `<div class="flex items-center justify-center py-16 text-slate"><span class="material-symbols-outlined animate-spin">progress_activity</span><span class="ml-2">Loading…</span></div>`; }
export function errorState(message) { return card(`<div class="text-center py-10"><span class="material-symbols-outlined text-error text-4xl">error</span><p class="mt-2 text-on-surface-variant">${esc(message)}</p></div>`); }
export function emptyState(message, icon = 'inbox') { return `<div class="text-center py-12 text-slate"><span class="material-symbols-outlined text-4xl">${esc(icon)}</span><p class="mt-2">${esc(message)}</p></div>`; }
