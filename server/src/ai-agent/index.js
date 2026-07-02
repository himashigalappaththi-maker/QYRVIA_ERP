'use strict';

/**
 * AI WhatsApp Booking Agent factory (Phase 27, foundation). Wires the provider
 * (mock), ephemeral conversation state, the agent service (-> BookingService),
 * and the WhatsApp gateway (mock transport). Consumes existing services only;
 * never writes PMS/OTA directly. Default OFF (built only when enabled).
 */

const env = require('../config/env');
const { buildAiAgentService } = require('./aiAgentService');
const { buildAgentProvider } = require('./providers/ProviderFactory');
const { buildConversationStateStore } = require('./conversationStateStore');
const { buildWhatsappGateway, buildMockWhatsappTransport } = require('./channels/whatsapp/whatsappGateway');

function buildAiAgent({ bookingService, ctx, provider: injectedProvider, providerKind, providerOpts, rateResolver, roomTypeResolver, transport } = {}) {
  // Phase 27.1A: the agent provider is a failover chain (primary -> fallback -> tertiary -> mock),
  // built from config + providerOpts. Default boot (vendor transports disabled) => Mock behavior.
  const provider = injectedProvider || buildAgentProvider(Object.assign({ primary: providerKind || env.AI_PROVIDER }, providerOpts || {}));
  const stateStore = buildConversationStateStore({});
  const service = buildAiAgentService({ bookingService, provider, stateStore, ctx, rateResolver, roomTypeResolver });
  const gateway = buildWhatsappGateway({ agentService: service, transport: transport || buildMockWhatsappTransport() });
  return { service, gateway, provider, stateStore };
}

module.exports = { buildAiAgent };
