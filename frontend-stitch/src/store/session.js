// Session store - secure-ish token + principal persistence with expiry.
// Storage is injectable so it is unit-testable in Node (no DOM).

const KEY = 'qyrvia.session';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}

export function createSession({ storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage());

  return {
    save(session) { store.setItem(KEY, JSON.stringify(session || {})); return session; },
    load() {
      const raw = store.getItem(KEY);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (_) { return null; }
    },
    clear() { store.removeItem(KEY); },
    getToken() { const s = this.load(); return s ? s.token || null : null; },
    getPrincipal() { const s = this.load(); return (s && s.principal) || null; },
    getRoles() { const p = this.getPrincipal(); return (p && p.roles) || []; },
    isAuthenticated(now = Date.now()) { return !!this.getToken() && !this.isExpired(now); },
    isExpired(now = Date.now()) {
      const s = this.load();
      if (!s || !s.token) return true;
      if (!s.expiresAt) return false;          // non-expiring token
      return Number(s.expiresAt) <= now;
    }
  };
}

export const session = createSession();
