// Tiny DOM helpers (no framework). Views build HTML strings; these mount + wire.

export function setHTML(container, html) { if (container) container.innerHTML = html; return container; }
export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

/** Escape user/API data before injecting into HTML. */
export function esc(v) {
  if (v == null) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Delegated click handler: on(container, '[data-action="x"]', handler). */
export function on(container, selector, event, handler) {
  container.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && container.contains(target)) handler(e, target);
  });
}
