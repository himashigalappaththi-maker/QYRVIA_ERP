'use strict';

/**
 * IntegrationRegistry (Phase 18) - registers external systems (OTA, POS,
 * PAYMENT, CHANNEL) with enable/disable. Single source of truth for which
 * integrations exist.
 */

const TYPES = Object.freeze({ OTA: 'OTA', POS: 'POS', PAYMENT: 'PAYMENT', CHANNEL: 'CHANNEL' });

function buildIntegrationRegistry() {
  const items = new Map();   // id -> integration

  return {
    TYPES,
    register({ id, type, config = {}, enabled = true } = {}) {
      if (!id) throw new Error('integration id required');
      if (!TYPES[type]) throw new Error('invalid_integration_type: ' + type);
      const rec = { id, type, config, enabled, registeredAt: new Date().toISOString() };
      items.set(id, rec);
      return Object.assign({}, rec);
    },
    get(id) { const r = items.get(id); return r ? Object.assign({}, r) : null; },
    list(filter = {}) {
      return Array.from(items.values())
        .filter((r) => (!filter.type || r.type === filter.type) && (filter.enabled == null || r.enabled === filter.enabled))
        .map((r) => Object.assign({}, r));
    },
    setEnabled(id, enabled) { const r = items.get(id); if (!r) return null; r.enabled = !!enabled; return Object.assign({}, r); }
  };
}

module.exports = { buildIntegrationRegistry };
