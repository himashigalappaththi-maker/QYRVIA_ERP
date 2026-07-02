'use strict';

/**
 * Canonical adapter registry (Phase 24 B8-A) - THE single source of truth for
 * OTA adapters under the unified contract. Replaces the deprecated filesystem
 * discovery registry (channel-manager/registry/*). Registration enforces
 * interface compliance, so a malformed adapter fails loudly at register time.
 */

const { validateInterface, validateAll } = require('./adapterValidator');

function buildAdapterRegistry() {
  const adapters = new Map();

  function register(adapter) {
    const v = validateInterface(adapter);
    if (!v.ok) throw new Error('adapterRegistry.register: adapter missing ' + v.missing.join(', '));
    if (adapters.has(adapter.channel)) throw new Error('adapterRegistry.register: duplicate channel ' + adapter.channel);
    adapters.set(adapter.channel, adapter);
    return adapter;
  }

  function get(channel) {
    const a = adapters.get(channel);
    if (!a) throw new Error('adapterRegistry.get: unknown channel ' + channel);
    return a;
  }

  function has(channel) { return adapters.has(channel); }
  function list() { return Array.from(adapters.keys()).sort(); }
  function all() { return Array.from(adapters.values()); }
  function unregister(channel) { return adapters.delete(channel); }
  function clear() { adapters.clear(); }

  async function validateAllAdapters(opts) {
    const out = {};
    for (const [channel, adapter] of adapters) out[channel] = await validateAll(adapter, opts);
    return out;
  }

  return { register, get, has, list, all, unregister, clear, validateAll: validateAllAdapters };
}

module.exports = { buildAdapterRegistry };
