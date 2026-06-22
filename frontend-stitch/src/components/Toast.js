// Toast notifications (used for API error/success feedback).
import { esc } from '../utils/dom.js';

export function toast(message, type = 'info') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const colors = { info: 'bg-charcoal text-white', success: 'bg-success text-white', error: 'bg-error text-on-error' };
  const node = document.createElement('div');
  node.className = `rounded-lg shadow-modal px-4 py-3 text-sm ${colors[type] || colors.info}`;
  node.innerHTML = esc(message);
  root.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; setTimeout(() => node.remove(), 300); }, 3500);
}
