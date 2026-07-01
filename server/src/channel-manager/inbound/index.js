'use strict';

/**
 * Channel inbound factory (Phase 24 B8-B4) - DI entry point. Wires the inbound
 * service (idempotent booking_store -> PMS commandBus) + the webhook ingress
 * (signature verification + adapter normalization).
 */

const { buildChannelInboundService } = require('./channelInboundService');
const { buildWebhookIngress } = require('./webhookIngress');

function buildChannelInbound({ registry, bookingStore, commandBus, resolveSecret, requireSignature, onAudit, commandMap, toReservationInput } = {}) {
  const service = buildChannelInboundService({ bookingStore, commandBus, onAudit, commandMap, toReservationInput });
  const ingress = buildWebhookIngress({ registry, inboundService: service, resolveSecret, requireSignature });
  return { service, ingress };
}

module.exports = { buildChannelInbound };
