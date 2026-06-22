// Router - the pure decision logic (resolve + guard) is separated from the DOM
// wiring so it is unit-testable in Node. `decide()` returns what should happen
// for a given path + auth state; `start()` (browser-only) listens to hashchange
// and renders.

import { resolveRoute, DEFAULT_AUTHED } from './routes.js';
import { canAccessRoute } from '../utils/rbac.js';

/**
 * Pure routing decision.
 * @returns { action: 'render'|'redirect', route?, to? }
 */
export function decide(path, { authenticated, principal } = {}) {
  const route = resolveRoute(path);

  // Unknown path -> dashboard (if authed) or login.
  if (!route) return { action: 'redirect', to: authenticated ? DEFAULT_AUTHED : '/login' };

  // Public routes (login): if already authed, bounce to dashboard.
  if (route.public) {
    if (authenticated && route.id === 'login') return { action: 'redirect', to: DEFAULT_AUTHED };
    return { action: 'render', route };
  }

  // Protected routes require auth, then permission.
  if (!authenticated) return { action: 'redirect', to: '/login' };
  if (!canAccessRoute(route, principal)) return { action: 'redirect', to: DEFAULT_AUTHED };
  return { action: 'render', route };
}

export function createRouter({ session, render, getPath, setPath, onChange } = {}) {
  function current() {
    const path = getPath();
    const d = decide(path, { authenticated: session.isAuthenticated(), principal: session.getPrincipal() });
    if (d.action === 'redirect') { setPath(d.to); return; }   // setPath re-triggers onChange
    render(d.route);
    if (onChange) onChange(d.route);
  }
  function navigate(to) { setPath(to); }
  return { current, navigate };
}
