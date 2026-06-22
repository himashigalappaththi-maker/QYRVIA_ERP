import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/store/session.js';

function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; }

test('save / load / clear round-trip', () => {
  const s = createSession({ storage: memStorage() });
  assert.equal(s.load(), null);
  s.save({ token: 't', expiresAt: Date.now() + 1000, principal: { userId: 'u1', roles: ['ADMIN'] } });
  assert.equal(s.getToken(), 't');
  assert.deepEqual(s.getRoles(), ['ADMIN']);
  s.clear();
  assert.equal(s.getToken(), null);
});

test('expiry handling', () => {
  const s = createSession({ storage: memStorage() });
  s.save({ token: 't', expiresAt: 1000, principal: {} });
  assert.equal(s.isExpired(2000), true);
  assert.equal(s.isAuthenticated(2000), false);
  s.save({ token: 't', expiresAt: 5000, principal: {} });
  assert.equal(s.isExpired(2000), false);
  assert.equal(s.isAuthenticated(2000), true);
});

test('no token => not authenticated', () => {
  const s = createSession({ storage: memStorage() });
  assert.equal(s.isAuthenticated(), false);
  assert.equal(s.isExpired(), true);
});
