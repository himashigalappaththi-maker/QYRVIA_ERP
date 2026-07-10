'use strict';

/**
 * Channel outbound sync / connectivity factory (Phase 24 B8-B3 + B8-B5).
 *
 * Builds the canonical adapter registry and the sync service:
 *   - QYRVIA_CONNECT: real, in-process transport (QYRVIA-owned B2B OTA/distribution platform).
 *   - Third-party OTAs: REAL HttpTransport when ACTIVATED (per-channel config with
 *     endpoint + credentials_ref); otherwise bridged mocks.
 * HTTP is gated by CHANNEL_HTTP_ENABLED (default off) so no external network call
 * occurs by default. Auth headers resolve via CredentialAuthStrategy -> SecretProvider
 * (credentials_ref); the core never sees a secret. Also exposes resolveSecret() for
 * inbound webhook signature verification.
 */

const env = require('../../config/env');
const memStores = require('../persistence/memoryStores');
const dbStores = require('../persistence/dbStores');
const { buildAdapterRegistry } = require('../adapters/framework/adapterRegistry');
const { bridgeLegacyAdapter } = require('../adapters/framework/legacyBridge');
const { TransportOTAAdapter } = require('../adapters/framework/TransportOTAAdapter');
const { CredentialAuthStrategy } = require('../adapters/framework/AuthStrategy');
const { buildInProcessTransport, buildHttpTransport } = require('../transport/transport');
const { buildChannelSyncService } = require('./channelSyncService');
const { buildSyncMonitor } = require('../ota/monitoring');
const { CHANNELS } = require('../core/canonical/types');

const { BookingComAdapter } = require('../adapters/bookingcom/BookingComAdapter');
const { AgodaAdapter } = require('../adapters/agoda/AgodaAdapter');
const { ExpediaAdapter } = require('../adapters/expedia/ExpediaAdapter');
const { AirbnbAdapter } = require('../adapters/airbnb/AirbnbAdapter');

const THIRD_PARTY = {
  [CHANNELS.BOOKING_COM]: BookingComAdapter,
  [CHANNELS.AGODA]: AgodaAdapter,
  [CHANNELS.EXPEDIA]: ExpediaAdapter,
  [CHANNELS.AIRBNB]: AirbnbAdapter
};

function parseActivations(activations) {
  if (activations && typeof activations === 'object') return activations;
  const raw = env.CHANNEL_OTA_ACTIVATIONS || '';
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function buildChannelOutboundSync({ mode, db, realChannels, onAudit, httpEnabled, fetchImpl, activations, secretProvider, channelRegistry } = {}) {
  const resolved = mode || env.CHANNEL_PERSISTENCE || 'memory';
  const haveDb = !!(db && typeof db.query === 'function');
  const syncStateStore = (resolved !== 'memory' && haveDb) ? dbStores.buildSyncStateStoreDb({ db }) : memStores.buildSyncStateStoreMemory();

  const acts = parseActivations(activations);
  const httpOn = httpEnabled != null ? httpEnabled : (env.CHANNEL_HTTP_ENABLED === 'true');

  const inproc = buildInProcessTransport();
  const registry = buildAdapterRegistry();
  registry.register(new TransportOTAAdapter({ channel: CHANNELS.QYRVIA_CONNECT, transport: inproc })); // REAL, in-process (QYRVIA Connect — QYRVIA-owned B2B OTA/distribution platform)

  const httpChannels = [];
  for (const [channel, Legacy] of Object.entries(THIRD_PARTY)) {
    const act = acts[channel];
    if (act && act.enabled && act.http && act.endpoint) {
      const transport = buildHttpTransport({ enabled: httpOn, fetchImpl }); // disabled => no network
      const auth = (secretProvider && act.credentials_ref)
        ? new CredentialAuthStrategy({ credentialsRef: act.credentials_ref, tenantId: act.tenant_id || null, secretProvider })
        : undefined;
      registry.register(new TransportOTAAdapter({ channel, transport, endpoint: act.endpoint, auth }));
      httpChannels.push(channel);
    } else {
      registry.register(bridgeLegacyAdapter(new Legacy())); // mock until activated
    }
  }

  const envReal = (env.CHANNEL_REALSYNC_CHANNELS || 'QYRVIA_CONNECT').split(',').map((s) => s.trim()).filter(Boolean);
  const real = (realChannels instanceof Set) ? realChannels : new Set([...envReal, ...httpChannels]);
  const syncMonitor = buildSyncMonitor();
  const service = buildChannelSyncService({ registry, syncStateStore, realChannels: real, onAudit, channelRegistry: channelRegistry || null });

  // Resolve a channel's inbound webhook signing secret via the SecretProvider.
  function resolveSecret({ tenantId, channel } = {}) {
    const act = acts[channel];
    if (!act || !act.credentials_ref || !secretProvider) return Promise.resolve(null);
    return Promise.resolve(secretProvider.get(act.credentials_ref, { tenant_id: tenantId || act.tenant_id }))
      .then((s) => (s && (s.webhook_secret || s.signing_secret || s.secret)) || null)
      .catch(() => null);
  }

  return { service, registry, syncStateStore, syncMonitor, transports: { inproc }, realChannels: real, activations: acts, httpChannels, resolveSecret, httpEnabled: httpOn, mode: resolved };
}

module.exports = { buildChannelOutboundSync };
