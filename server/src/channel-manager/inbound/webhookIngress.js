'use strict';

/**
 * webhookIngress (Phase 24 B8-B4) - the inbound entry: resolve the channel's
 * canonical adapter, verify the signature (when a secret is configured), let the
 * adapter normalize the payload, then ingest each canonical booking idempotently.
 *
 * Transport-agnostic: `handle()` takes a plain request shape so it can be driven
 * by an HTTP route or a test directly. No external network.
 */

const { verify } = require('./webhookVerifier');

function buildWebhookIngress({ registry, inboundService, resolveSecret, requireSignature = false } = {}) {
  if (!registry) throw new Error('webhookIngress: registry required');
  if (!inboundService) throw new Error('webhookIngress: inboundService required');

  async function handle({ channel, rawBody, body, signature, ctx } = {}) {
    if (!ctx || !ctx.tenantId) return { ok: false, status: 401, error: 'tenant_required' };

    let adapter;
    try { adapter = registry.get(channel); } catch (_) { return { ok: false, status: 404, error: 'unknown_channel' }; }

    const secret = resolveSecret ? await resolveSecret({ tenantId: ctx.tenantId, channel }) : null;
    if (secret) {
      const okSig = verify({ secret, payload: rawBody != null ? rawBody : (body || {}), signature });
      if (!okSig) return { ok: false, status: 401, error: 'invalid_signature' };
    } else if (requireSignature) {
      return { ok: false, status: 401, error: 'signature_required' };
    }

    const wh = adapter.handleWebhook({ bookings: (body && (body.bookings || body.events)) || body });
    if (!wh || !wh.verified) return { ok: false, status: 400, error: 'webhook_not_verified' };

    const ingested = [];
    for (const ev of (wh.events || [])) ingested.push(await inboundService.ingest(ev, { ctx }));
    return { ok: true, status: 200, ingested };
  }

  return { handle };
}

module.exports = { buildWebhookIngress };
