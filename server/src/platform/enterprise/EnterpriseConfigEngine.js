'use strict';

/**
 * EnterpriseConfigEngine (Phase 18) - platform-wide settings: security
 * defaults, feature toggles, and integration enablement. Property-level
 * overrides resolve over the global defaults.
 */

const DEFAULTS = Object.freeze({
  security: { rateLimitPerMin: 120, sessionTtlMinutes: 30, denyByDefault: true },
  features: {},
  integrations: {}
});

function buildEnterpriseConfigEngine({ defaults } = {}) {
  const global = JSON.parse(JSON.stringify(defaults || DEFAULTS));
  const perProperty = new Map();   // propertyId -> overrides

  return {
    getGlobal() { return JSON.parse(JSON.stringify(global)); },
    setGlobal(path, value) {
      const parts = path.split('.'); let node = global;
      for (let i = 0; i < parts.length - 1; i++) { node[parts[i]] = node[parts[i]] || {}; node = node[parts[i]]; }
      node[parts[parts.length - 1]] = value; return value;
    },
    setPropertyOverride(propertyId, overrides) { perProperty.set(propertyId, Object.assign({}, perProperty.get(propertyId), overrides)); },
    resolve(propertyId) {
      const base = JSON.parse(JSON.stringify(global));
      const ov = perProperty.get(propertyId);
      return ov ? Object.assign(base, ov) : base;
    },
    isFeatureEnabled(name, propertyId) {
      const cfg = this.resolve(propertyId);
      return !!(cfg.features && cfg.features[name]);
    },
    setFeature(name, enabled) { global.features[name] = !!enabled; }
  };
}

module.exports = { buildEnterpriseConfigEngine, DEFAULTS };
