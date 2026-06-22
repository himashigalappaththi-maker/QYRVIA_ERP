'use strict';

/**
 * Webhook framework.
 *
 *   registerEndpoint({ name, url, secret?, eventTypes?, createdBy }, ctx) -> { id }
 *   listEndpoints(ctx) -> [{...}]
 *   disableEndpoint(id, ctx) -> { ok }
 *   enqueue(event, ctx)            -- fans out to matching endpoints; one delivery row per endpoint
 *   deliverPending({ limit })       -- pulls due deliveries, POSTs them, marks delivered or schedules retry (exponential backoff)
 *
 * Signing: HMAC-SHA256 over `${timestamp}.${payload}`. Header sent as
 * `X-QYRVIA-Signature: t=<ts>,v1=<hex>`.
 *
 * Phase 3: real HTTP delivery is attempted when STUB_WEBHOOK_DELIVERY is not
 * set. Tests pass `fetchImpl` in deps to intercept.
 */

const crypto = require('crypto');
const { makeEvent } = require('../core/event');
const eventBus      = require('../core/eventBus');
const logger        = require('../config/logger');

function signPayload(secret, payload) {
  const ts = Math.floor(Date.now() / 1000);
  const body = ts + '.' + JSON.stringify(payload);
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return { header: 't=' + ts + ',v1=' + hex, signature: hex, timestamp: ts };
}

function nextBackoffMs(attempts) {
  // 1s, 5s, 25s, 2m, 10m capped
  const ladder = [1000, 5000, 25000, 120000, 600000];
  return ladder[Math.min(attempts, ladder.length - 1)];
}

function buildWebhookService({ repo, fetchImpl }) {
  if (!repo) throw new Error('buildWebhookService: repo required');
  const _fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const stubMode = !!process.env.STUB_WEBHOOK_DELIVERY;

  async function registerEndpoint({ name, url, secret, eventTypes, createdBy }, ctx) {
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };
    if (!name || !url) return { ok: false, error: 'missing_fields' };
    const finalSecret = secret || crypto.randomBytes(24).toString('base64url');
    const row = await repo.insertWebhookEndpoint({
      tenant_id:   ctx.tenantId,
      property_id: ctx.propertyId || null,
      name:        String(name).slice(0, 120),
      url:         String(url).slice(0, 500),
      secret:      finalSecret,
      event_types: Array.isArray(eventTypes) ? eventTypes : [],
      created_by:  createdBy || ctx.actorId || null
    });
    try {
      await eventBus.publish(makeEvent({
        type:          'webhook.endpoint_registered',
        aggregateType: 'webhook_endpoint',
        aggregateId:   row.id,
        payload:       { name, url, event_types: eventTypes || [], actor_name: ctx.actorName || null },
        ctx
      }));
    } catch (e) { logger.error({ err: e }, '[webhook] audit publish failed'); }
    return { ok: true, id: row.id, secret: finalSecret };
  }

  async function listEndpoints(ctx) {
    if (!ctx || !ctx.tenantId) return [];
    return repo.listWebhookEndpoints(ctx.tenantId);
  }

  async function disableEndpoint(id, ctx) {
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };
    const ok = await repo.disableWebhookEndpoint(ctx.tenantId, id);
    if (ok) {
      try {
        await eventBus.publish(makeEvent({
          type:          'webhook.endpoint_disabled',
          aggregateType: 'webhook_endpoint',
          aggregateId:   id,
          payload:       { actor_name: ctx.actorName || null },
          ctx
        }));
      } catch (e) { logger.error({ err: e }, '[webhook] audit publish failed'); }
    }
    return { ok };
  }

  /**
   * Enqueue an event for delivery to all matching endpoints. Called by an
   * eventBus subscriber wired at boot - one delivery row per endpoint.
   */
  async function enqueue(event, ctx) {
    const endpoints = await repo.listActiveEndpointsForEvent(event.tenant_id, event.event_type);
    let enqueued = 0;
    for (const ep of endpoints) {
      const { header, signature } = signPayload(ep.secret, event);
      await repo.insertWebhookDelivery({
        tenant_id:    event.tenant_id,
        endpoint_id:  ep.id,
        event_id:     event.event_id || null,
        event_type:   event.event_type,
        payload:      { event, signature_header: header },
        signature
      });
      enqueued++;
    }
    return { enqueued };
  }

  async function deliverPending({ limit = 25 } = {}) {
    const due = await repo.claimDueWebhookDeliveries({ limit });
    let delivered = 0, failed = 0;
    for (const d of due) {
      if (stubMode) {
        await repo.markWebhookDelivered(d.id, 200);
        delivered++;
        continue;
      }
      if (!_fetch) {
        await repo.markWebhookFailed(d.id, 'no_fetch_impl', null, new Date(Date.now() + nextBackoffMs(d.attempts)).toISOString(), false);
        failed++;
        continue;
      }
      try {
        const ep = await repo.findWebhookEndpoint(d.endpoint_id);
        if (!ep || !ep.is_active) {
          await repo.markWebhookFailed(d.id, 'endpoint_disabled', null, null, true);
          failed++;
          continue;
        }
        const resp = await _fetch(ep.url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-QYRVIA-Signature': d.payload.signature_header },
          body:    JSON.stringify(d.payload.event)
        });
        if (resp.ok || (resp.status >= 200 && resp.status < 300)) {
          await repo.markWebhookDelivered(d.id, resp.status);
          delivered++;
        } else {
          const reachedMax = (d.attempts + 1) >= (d.max_attempts || 5);
          await repo.markWebhookFailed(d.id, 'http_' + resp.status, resp.status,
            new Date(Date.now() + nextBackoffMs(d.attempts)).toISOString(), reachedMax);
          failed++;
        }
      } catch (err) {
        const reachedMax = (d.attempts + 1) >= (d.max_attempts || 5);
        await repo.markWebhookFailed(d.id, String(err.message || err), null,
          new Date(Date.now() + nextBackoffMs(d.attempts)).toISOString(), reachedMax);
        failed++;
      }
    }
    return { delivered, failed };
  }

  return { registerEndpoint, listEndpoints, disableEndpoint, enqueue, deliverPending, signPayload };
}

module.exports = { buildWebhookService, signPayload, nextBackoffMs };
