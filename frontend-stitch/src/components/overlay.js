// Overlay host for modals/drawers. Views render an overlay (from ui.modal /
// ui.drawer) via openOverlay() and wire its form/buttons in the callback.
// Close is handled centrally: backdrop / close button (data-action=modal-close)
// and the Escape key.
import { on } from '../utils/dom.js';

function ensureRoot() {
  let root = document.getElementById('overlay-root');
  if (!root) { root = document.createElement('div'); root.id = 'overlay-root'; document.body.appendChild(root); }
  return root;
}

function escClose(e) { if (e.key === 'Escape') closeOverlay(); }

export function openOverlay(html, wire) {
  const root = ensureRoot();
  root.innerHTML = html;
  on(root, '[data-action="modal-close"]', 'click', () => closeOverlay());
  document.addEventListener('keydown', escClose);
  if (typeof wire === 'function') wire(root);
  return root;
}

export function closeOverlay() {
  const root = document.getElementById('overlay-root');
  if (root) root.innerHTML = '';
  document.removeEventListener('keydown', escClose);
}
