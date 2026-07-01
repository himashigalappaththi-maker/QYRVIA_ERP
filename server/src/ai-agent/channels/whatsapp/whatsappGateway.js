'use strict';

/**
 * WhatsApp channel abstraction (Phase 27) - inbound/outbound message boundary.
 * NO Meta WhatsApp API integration; MOCK transport only. The gateway turns an
 * inbound message into an agent turn and sends the reply via the transport.
 */

function buildMockWhatsappTransport() {
  const outbox = [];
  return {
    kind: 'mock',
    outbox,
    async send(to, message) { outbox.push({ to, message, at: Date.now() }); return { ok: true }; },
    async close() {}
  };
}

function buildWhatsappGateway({ agentService, transport } = {}) {
  if (!agentService) throw new Error('whatsappGateway: agentService required');
  const tx = transport || buildMockWhatsappTransport();

  // Inbound: { from, text, ctx } -> agent turn -> outbound reply via transport.
  async function receive({ from, text, ctx } = {}) {
    const res = await agentService.handleMessage({ conversationId: from, text, ctx });
    await tx.send(from, res.reply);
    return res;
  }

  return { receive, transport: tx };
}

module.exports = { buildWhatsappGateway, buildMockWhatsappTransport };
