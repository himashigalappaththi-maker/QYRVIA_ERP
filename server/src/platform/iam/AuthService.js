'use strict';

/**
 * AuthService (Phase 18) - login / logout / refresh / session validation.
 *
 * Self-contained and deterministic: it issues opaque session tokens stored in
 * an in-memory session store with TTL (injectable clock + id generator). A
 * `userProvider.verify(username, password)` returns the principal; a default
 * in-memory user store is provided for tests. In production this can be wired
 * to the existing identity service without changing callers.
 */

const crypto = require('crypto');

function buildInMemoryUserProvider(users = []) {
  const byName = new Map(users.map((u) => [u.username, u]));
  return {
    async verify(username, password) {
      const u = byName.get(username);
      if (!u || u.password !== password) return null;
      return { userId: u.userId, roles: u.roles || [], properties: u.properties || [] };
    }
  };
}

function buildAuthService({ userProvider, clock, idGen, ttlMs } = {}) {
  const provider = userProvider || buildInMemoryUserProvider([]);
  const now = clock || (() => Date.now());
  const newId = idGen || (() => crypto.randomUUID());
  const ttl = ttlMs != null ? ttlMs : 30 * 60 * 1000;
  const sessions = new Map();   // token -> session

  function issue(principal) {
    const token = newId();
    const refreshToken = newId();
    const session = { token, refreshToken, userId: principal.userId, roles: principal.roles,
      properties: principal.properties, issuedAt: now(), expiresAt: now() + ttl };
    sessions.set(token, session);
    return session;
  }

  return {
    async login({ username, password } = {}) {
      const principal = await provider.verify(username, password);
      if (!principal) return { ok: false, error: 'invalid_credentials' };
      const s = issue(principal);
      return { ok: true, token: s.token, refreshToken: s.refreshToken, expiresAt: s.expiresAt,
        principal: { userId: s.userId, roles: s.roles, properties: s.properties } };
    },

    async validate(token) {
      const s = sessions.get(token);
      if (!s) return { ok: false, error: 'invalid_token' };
      if (s.expiresAt <= now()) { sessions.delete(token); return { ok: false, error: 'expired_token' }; }
      return { ok: true, principal: { userId: s.userId, roles: s.roles, properties: s.properties }, sessionId: s.token };
    },

    async refresh(refreshToken) {
      const s = Array.from(sessions.values()).find((x) => x.refreshToken === refreshToken && x.expiresAt > now());
      if (!s) return { ok: false, error: 'invalid_refresh' };
      sessions.delete(s.token);
      const fresh = issue({ userId: s.userId, roles: s.roles, properties: s.properties });
      return { ok: true, token: fresh.token, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt };
    },

    async logout(token) { return { ok: sessions.delete(token) }; },

    _sessions: sessions
  };
}

module.exports = { buildAuthService, buildInMemoryUserProvider };
