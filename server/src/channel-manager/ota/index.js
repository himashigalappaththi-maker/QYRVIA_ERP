'use strict';

/**
 * OTA Transport Layer (Phase 30.2) - public entry point.
 *
 * Additive + standalone: a production-grade outbound transport (auth / retry / ack /
 * rate-limit / per-OTA codec + error mapping), a reconciliation engine, and sync
 * monitoring, with PostgreSQL persistence + FORCE RLS. NOT wired into the canonical
 * registry/adapters or the Booking Engine/PMS here (preserves Phase 28 + backward
 * compatibility); a later phase composes it. HTTP is injected + DEFAULT-DISABLED, so
 * there is no live OTA call and no certification claim.
 */

const { buildOtaTransport, buildDisabledHttp, buildRateLimiter, normalizeAck } = require('./transport');
const providers = require('./providers');
const { reconcile } = require('./reconciliation');
const { buildSyncMonitor } = require('./monitoring');
const { buildOtaMemoryStore } = require('./store/memoryStore');

function buildOtaTransportLayer({ http, store, clock, sleep } = {}) {
  const s = store || buildOtaMemoryStore();
  const monitor = buildSyncMonitor({ store: s, clock });

  /** Build a transport bound to a channel's provider (auth/http/retry injectable). */
  function transportFor(channel, opts = {}) {
    const provider = providers.getProvider(channel);
    return buildOtaTransport(Object.assign({ provider, http, sleep, clock }, opts));
  }

  return {
    transportFor, reconcile, monitor, store: s,
    getProvider: providers.getProvider, hasProvider: providers.hasProvider, listProviders: providers.listProviders
  };
}

module.exports = {
  buildOtaTransportLayer,
  buildOtaTransport, buildDisabledHttp, buildRateLimiter, normalizeAck,
  reconcile, buildSyncMonitor, buildOtaMemoryStore, providers
};
