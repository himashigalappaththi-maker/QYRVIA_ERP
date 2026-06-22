'use strict';

/**
 * IntegrationAdapterEngine (Phase 18) - the standard external-system adapter
 * contract + registry. Adapters are isolated (one per external system) and
 * validated against the contract.
 *
 *   syncReservations(), pushRates(), pushInventory()/pushAvailability(),
 *   pullBookings()
 */

const REQUIRED = ['syncReservations', 'pushRates', 'pushAvailability', 'pullBookings'];

function assertAdapter(adapter) {
  const missing = [];
  if (!adapter || !adapter.name) missing.push('name');
  for (const m of REQUIRED) if (!adapter || typeof adapter[m] !== 'function') missing.push(m);
  return { ok: missing.length === 0, missing };
}

function buildIntegrationAdapterEngine() {
  const adapters = new Map();
  return {
    REQUIRED,
    assertAdapter,
    register(adapter) {
      const chk = assertAdapter(adapter);
      if (!chk.ok) throw new Error('adapter missing: ' + chk.missing.join(','));
      adapters.set(adapter.name, adapter);
      return adapter.name;
    },
    get(name) { const a = adapters.get(name); if (!a) throw new Error('unknown_adapter: ' + name); return a; },
    list() { return Array.from(adapters.keys()); }
  };
}

module.exports = { buildIntegrationAdapterEngine, assertAdapter, REQUIRED };
