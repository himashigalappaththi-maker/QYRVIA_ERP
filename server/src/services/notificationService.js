'use strict';

/**
 * Notification framework.
 *
 *   requestNotification({ channel, recipient, templateCode?, body?, subject?, context? }, ctx)
 *     -> { id, status }
 *   findById(id, ctx) -> notification + delivery_log array
 *   list(ctx, { status?, limit? })
 *   sendPending({ limit })  -- pulls pending notifications, attempts delivery via the
 *                              registered provider for the channel. With no provider
 *                              registered, marks as not_configured and records the
 *                              attempt in notification_delivery_log.
 *
 *   registerProvider(channel, adapter) -- future hooks for SMTP/Twilio/Meta etc.
 *
 * Phase 3: no real provider integrations. Every send attempt logs a row.
 *
 * Audit: each requestNotification publishes 'notification.requested'; each
 * delivery attempt publishes 'notification.delivery_attempted'.
 */

const { makeEvent } = require('../core/event');
const eventBus      = require('../core/eventBus');
const logger        = require('../config/logger');

function renderTemplate(tpl, context) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let v = context || {};
    for (const p of parts) v = (v && typeof v === 'object') ? v[p] : undefined;
    return v == null ? '' : String(v);
  });
}

function buildNotificationService({ repo }) {
  if (!repo) throw new Error('buildNotificationService: repo required');
  const providers = new Map();

  function registerProvider(channel, adapter) {
    providers.set(channel, adapter);
  }

  async function requestNotification({ channel, recipient, templateCode, subject, body, context }, ctx) {
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };
    if (!channel || !recipient) return { ok: false, error: 'missing_fields' };
    if (!['email','sms','whatsapp','in_app'].includes(channel)) return { ok: false, error: 'invalid_channel' };

    // Resolve template if specified - tenant-scoped
    let resolvedSubject = subject || null;
    let resolvedBody    = body    || '';
    if (templateCode) {
      const tpl = await repo.findActiveTemplate(ctx.tenantId, templateCode, channel);
      if (!tpl) return { ok: false, error: 'template_not_found' };
      resolvedSubject = renderTemplate(tpl.subject, context || {});
      resolvedBody    = renderTemplate(tpl.body,    context || {});
    }
    if (!resolvedBody) return { ok: false, error: 'empty_body' };

    const row = await repo.insertNotification({
      tenant_id:     ctx.tenantId,
      property_id:   ctx.propertyId || null,
      channel,
      template_code: templateCode || null,
      recipient,
      subject:       resolvedSubject,
      body:          resolvedBody,
      context:       context || {},
      requested_by:  ctx.actorId || null,
      status:        'pending'
    });

    try {
      await eventBus.publish(makeEvent({
        type:          'notification.requested',
        aggregateType: 'notification',
        aggregateId:   row.id,
        payload:       { channel, recipient, template_code: templateCode || null },
        ctx
      }));
    } catch (e) { logger.error({ err: e }, '[notif] audit publish failed'); }

    return { ok: true, id: row.id, status: row.status };
  }

  async function findById(id, ctx) {
    if (!ctx || !ctx.tenantId) return null;
    return repo.findNotificationById(ctx.tenantId, id);
  }

  async function list(ctx, opts = {}) {
    if (!ctx || !ctx.tenantId) return [];
    return repo.listNotifications(ctx.tenantId, opts.status || null, opts.limit || 100);
  }

  /**
   * Pull pending notifications, attempt delivery via channel provider.
   * No real providers registered in Phase 3 -> marks as not_configured.
   * Always persists a row in notification_delivery_log.
   */
  async function sendPending({ limit = 25 } = {}) {
    const pending = await repo.claimPendingNotifications({ limit });
    let attempted = 0, delivered = 0, failed = 0, notConfigured = 0;
    for (const n of pending) {
      attempted++;
      const provider = providers.get(n.channel);
      const ctx = { tenantId: n.tenant_id, propertyId: n.property_id, requestId: 'send-' + n.id, actorId: null };
      const nextAttempt = (await repo.nextAttemptNo(n.id));
      if (!provider) {
        await repo.markNotificationStatus(n.id, 'not_configured');
        await repo.insertDeliveryLog({
          notification_id: n.id, tenant_id: n.tenant_id,
          attempt_no: nextAttempt, status: 'not_configured',
          provider: null, error: 'no_provider_registered'
        });
        try {
          await eventBus.publish(makeEvent({
            type:          'notification.delivery_attempted',
            aggregateType: 'notification',
            aggregateId:   n.id,
            payload:       { status: 'not_configured', channel: n.channel },
            ctx
          }));
        } catch (_) {}
        notConfigured++;
        continue;
      }
      try {
        const r = await provider.send({ recipient: n.recipient, subject: n.subject, body: n.body, context: n.context });
        const status = r && r.ok ? 'delivered' : 'failed';
        await repo.markNotificationStatus(n.id, status);
        await repo.insertDeliveryLog({
          notification_id: n.id, tenant_id: n.tenant_id,
          attempt_no: nextAttempt, status,
          provider: (r && r.provider) || null,
          provider_ref: (r && r.provider_ref) || null,
          error: (r && r.error) || null
        });
        try {
          await eventBus.publish(makeEvent({
            type:          'notification.delivery_attempted',
            aggregateType: 'notification',
            aggregateId:   n.id,
            payload:       { status, channel: n.channel },
            ctx
          }));
        } catch (_) {}
        if (status === 'delivered') delivered++; else failed++;
      } catch (err) {
        await repo.markNotificationStatus(n.id, 'failed');
        await repo.insertDeliveryLog({
          notification_id: n.id, tenant_id: n.tenant_id,
          attempt_no: nextAttempt, status: 'failed',
          provider: null, error: String(err.message || err)
        });
        failed++;
      }
    }
    return { attempted, delivered, failed, notConfigured };
  }

  return { requestNotification, findById, list, sendPending, registerProvider, _renderTemplate: renderTemplate };
}

module.exports = { buildNotificationService };
