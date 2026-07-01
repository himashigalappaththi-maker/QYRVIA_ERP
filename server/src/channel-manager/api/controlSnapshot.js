'use strict';

/**
 * Control-center snapshot (Phase 25) - a NON-SECRET operational view of the
 * channel/OTA + persistence subsystems for the UI control layer. Aggregates only
 * status/metadata (channel sync state, real/http channels, persistence mode,
 * worker/webhook/http flags, credential-provider presence, mapping count). It
 * NEVER returns secrets or credential payloads.
 */

function safe(fn, fallback = null) { try { return fn(); } catch (_) { return fallback; } }

function buildControlSnapshot(deps = {}, ctx = {}, env = {}) {
  const { channelManager, channelOutboundSync, channelMapping, channelCredentials, channelPersistence } = deps;

  const status = (channelManager && typeof channelManager.status === 'function') ? safe(() => channelManager.status()) : null;
  let mappingsCount = null;
  if (channelMapping && channelMapping.service && ctx.tenantId) {
    mappingsCount = safe(() => channelMapping.service.listMappings({ tenant_id: ctx.tenantId }).length, null);
  }

  return {
    channels:    (status && status.channels) || [],
    queue:       (status && status.queue) || null,
    bookings:    (status && status.bookings != null) ? status.bookings : null,
    sync: {
      realChannels: channelOutboundSync ? Array.from(channelOutboundSync.realChannels || []) : [],
      httpChannels: (channelOutboundSync && channelOutboundSync.httpChannels) || [],
      httpEnabled:  env.CHANNEL_HTTP_ENABLED === 'true'
    },
    persistence: { mode: (channelPersistence && channelPersistence.mode) || 'memory' },
    credentials: { providerActive: !!(channelCredentials && channelCredentials.hasProvider) },
    worker:      { enabled: env.CHANNEL_WORKER_ENABLED === 'true' },
    webhook:     { enabled: env.CHANNEL_WEBHOOK_ENABLED === 'true' },
    mappings:    { count: mappingsCount }
  };
}

module.exports = { buildControlSnapshot };
