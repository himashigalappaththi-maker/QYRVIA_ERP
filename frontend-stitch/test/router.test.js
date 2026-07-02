import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/app/router.js';

test('unknown path redirects (dashboard if authed, login if not)', () => {
  assert.deepEqual(decide('/nope', { authenticated: true, principal: { roles: ['ADMIN'] } }), { action: 'redirect', to: '/dashboard' });
  assert.deepEqual(decide('/nope', { authenticated: false }), { action: 'redirect', to: '/login' });
});

test('login route: bounce to dashboard when already authed', () => {
  const d = decide('/login', { authenticated: true, principal: { roles: ['ADMIN'] } });
  assert.deepEqual(d, { action: 'redirect', to: '/dashboard' });
  assert.equal(decide('/login', { authenticated: false }).action, 'render');
});

test('protected route requires auth then permission (real backend codes)', () => {
  assert.deepEqual(decide('/billing', { authenticated: false }), { action: 'redirect', to: '/login' });
  // authed but lacking permission -> redirect to dashboard
  assert.deepEqual(decide('/billing', { authenticated: true, principal: { permissions: ['housekeeping.read'] } }), { action: 'redirect', to: '/dashboard' });
  // authorized (has invoice.read) -> render
  const ok = decide('/billing', { authenticated: true, principal: { permissions: ['invoice.read'] } });
  assert.equal(ok.action, 'render');
  assert.equal(ok.route.id, 'billing');
});

test('dashboard accessible to any authenticated user (no permission gate)', () => {
  const d = decide('/dashboard', { authenticated: true, principal: { permissions: [] } });
  assert.equal(d.action, 'render');
});
