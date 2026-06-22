'use strict';

/**
 * PropertyRegistryEngine (Phase 18) - enterprise property metadata: config
 * overrides, branding separation, and timezone per property.
 */

function buildPropertyRegistryEngine() {
  const props = new Map();

  return {
    register({ propertyId, name, timezone = 'UTC', branding = {}, configOverrides = {} } = {}) {
      if (!propertyId) throw new Error('propertyId required');
      const rec = { propertyId, name: name || propertyId, timezone, branding, configOverrides, updatedAt: new Date().toISOString() };
      props.set(propertyId, rec);
      return Object.assign({}, rec);
    },
    get(propertyId) { const r = props.get(propertyId); return r ? Object.assign({}, r) : null; },
    list() { return Array.from(props.values()).map((r) => Object.assign({}, r)); },
    update(propertyId, patch = {}) {
      const r = props.get(propertyId);
      if (!r) return null;
      Object.assign(r, patch, { updatedAt: new Date().toISOString() });
      return Object.assign({}, r);
    }
  };
}

module.exports = { buildPropertyRegistryEngine };
