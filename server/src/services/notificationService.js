'use strict';

/**
 * Notification framework.
 *
 *   requestNotification({ channel, recipient, templateCode?, body?, subject?, context? }, ctx)
 *     -> { id, status }
 *   findById(id, ctx) -> notification + delivery_log array
 *   list(ctx, { status?, limit? })
 *   sendPending({ workerId?, limit?, leaseMinutes?, client })
 *     -> { claimed, delivered, retried, failed, skipped }
 *   registerProvider(channel, adapter)
 *
 * Phase 58: sendPending uses explicit retry repo methods — explicit client required,
 * attempt_count incremented exactly once (in beginNotificationAttempt), ownership
 * checked on every transition, per-notification errors isolated so the batch continues.
 */

const os = require('node:os');

const { makeEvent } = require('../core/event');
const eventBus      = require('../core/eventBus');
const logger        = require('../config/logger');

// ── Error classification ──────────────────────────────────────────────────────

const RETRYABLE_SYSCODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT',
]);
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'timeout', 'smtp_timeout', 'connect_timeout', 'read_timeout',
  'connection_reset', 'connection_refused',
  'rate_limited', 'too_many_requests',
  'temporary_outage', 'server_error', 'service_unavailable',
  'bad_gateway', 'gateway_timeout',
]);
const PERMANENT_CODES = new Set([
  'invalid_recipient', 'invalid_address', 'malformed_request', 'unsupported_type',
  'expired_token', 'crypto_failure',
  'permanent_bounce', 'hard_bounce', 'account_suspended', 'domain_not_found',
]);

function _classifyThrownError(err) {
  const code   = (err.code   || '').toUpperCase();
  const lcode  = (err.code   || '').toLowerCase();
  const status = Number(err.status || err.statusCode || 0);

  if (RETRYABLE_SYSCODES.has(code))           return 'retryable';
  if (RETRYABLE_HTTP_STATUS.has(status))       return 'retryable';
  if (RETRYABLE_CODES.has(lcode))              return 'retryable';
  if (PERMANENT_CODES.has(lcode))              return 'permanent';
  return 'retryable'; // unknown thrown exceptions default to retryable (usually transient infra)
}

function _classifyProviderResult(result) {
  const errCode = ((result && result.error) || '').toLowerCase();
  if (PERMANENT_CODES.has(errCode)) return 'permanent';
  if (RETRYABLE_CODES.has(errCode)) return 'retryable';
  return 'permanent'; // explicit provider rejection without recognised code → permanent
}

// ── Backoff schedule ──────────────────────────────────────────────────────────
// attempt 1 → +5 min, attempt 2 → +30 min, attempt 3+ → +120 min (max)

const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 120 * 60_000];

function _nextAttemptAt(attemptCount) {
  const idx = Math.max(0, Math.min(attemptCount - 1, BACKOFF_MS.length - 1));
  return new Date(Date.now() + BACKOFF_MS[idx]).toISOString();
}

// ── Template rendering ────────────────────────────────────────────────────────

function renderTemplate(tpl, context) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let v = context || {};
    for (const p of parts) v = (v && typeof v === 'object') ? v[p] : undefined;
    return v == null ? '' : String(v);
  });
}

// ── Service factory ───────────────────────────────────────────────────────────

function buildNotificationService({ repo, workerId: injectedWorkerId } = {}) {
  if (!repo) throw new Error('buildNotificationService: repo required');

  // Stable process-level worker identity. Not derived from tenant, recipient, or secrets.
  const _workerId = injectedWorkerId || (os.hostname() + ':' + process.pid);

  const providers = new Map();

  function registerProvider(channel, adapter) {
    providers.set(channel, adapter);
  }

  async function requestNotification({ channel, recipient, templateCode, subject, body, context }, ctx, client) {
    if (!client || typeof client.query !== 'function') {
      const err = new Error('Notification client required');
      err.code = 'NOTIFICATION_CLIENT_REQUIRED';
      throw err;
    }
    if (!ctx || !ctx.tenantId) return { ok: false, error: 'tenant_required' };
    if (!channel || !recipient) return { ok: false, error: 'missing_fields' };
    if (!['email', 'sms', 'whatsapp', 'in_app'].includes(channel)) return { ok: false, error: 'invalid_channel' };

    let resolvedSubject = subject || null;
    let resolvedBody    = body    || '';
    if (templateCode) {
      const tpl = await repo.findActiveTemplate(ctx.tenantId, templateCode, channel);
      if (!tpl) return { ok: false, error: 'template_not_found' };
      resolvedSubject = renderTemplate(tpl.subject, context || {});
      resolvedBody    = renderTemplate(tpl.body,    context || {});
    }
    if (!resolvedBody) return { ok: false, error: 'empty_body' };

    const result = await repo.insertNotification({
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
    }, client);

    const row     = result.row;
    const created = result.created;

    if (created) {
      try {
        await eventBus.publish(makeEvent({
          type:          'notification.requested',
          aggregateType: 'notification',
          aggregateId:   row.id,
          // recipient excluded — audit events must not carry PII
          payload:       { channel, template_code: templateCode || null },
          ctx
        }));
      } catch (e) { logger.error({ notificationId: row.id }, '[notif] audit publish failed'); }
    }

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
   * Phase 58 retry worker. Claims pending notifications and attempts delivery.
   *
   * @param {object} opts
   * @param {string}  [opts.workerId]        Stable worker identity; defaults to hostname:pid.
   * @param {number}  [opts.limit=25]        Max notifications to claim per run.
   * @param {number}  [opts.leaseMinutes=10] Stale-lease recovery threshold.
   * @param {object}  opts.client            Tenant-scoped DB client (required).
   *
   * @returns {{ claimed, delivered, retried, failed, skipped }}
   */
  async function sendPending({ workerId: callerWorkerId, limit = 25, leaseMinutes = 10, client } = {}) {
    if (!client) throw Object.assign(
      new Error('sendPending: tenant-scoped DB client required'),
      { code: 'NOTIFICATION_CLIENT_REQUIRED' }
    );
    const workerId = callerWorkerId || _workerId;

    const claimed  = await repo.claimPendingNotifications({ workerId, limit, leaseMinutes }, client);
    const summary  = { claimed: claimed.length, delivered: 0, retried: 0, failed: 0, skipped: 0 };

    for (const n of claimed) {
      try {
        await _processOne(n, workerId, client, summary);
      } catch (err) {
        // Per-notification unexpected error — log bounded fields only, continue the batch.
        logger.warn({
          notificationId: n.id,
          channel:        n.channel,
          workerId,
          errCode:        err.code || 'UNEXPECTED',
        }, '[notif] unhandled error processing notification');
        summary.skipped++;
      }
    }

    return summary;
  }

  async function _processOne(n, workerId, client, summary) {
    // Derive one stable idempotency key from the notification ID — not from recipient or content.
    const idempotencyKey = 'qyrvia-notification:' + n.id;

    // Increment attempt_count exactly once before any real provider call.
    const begun = await repo.beginNotificationAttempt(n.id, workerId, idempotencyKey, client);
    if (!begun) {
      // Lost ownership (reclaimed by another worker) or idempotency key conflict.
      logger.warn({ notificationId: n.id, workerId }, '[notif] lost ownership before send');
      summary.skipped++;
      return;
    }

    const expectedAttemptCount = begun.attempt_count;
    const provider             = providers.get(n.channel);

    if (!provider) {
      // No provider configured — permanent terminal failure. Never silently succeed.
      logger.info({
        notificationId: n.id,
        channel:        n.channel,
        attemptNo:      expectedAttemptCount,
        workerId,
        failureClass:   'permanent',
      }, '[notif] no provider configured');

      await repo.markNotificationFailed(n.id, workerId, expectedAttemptCount, 'permanent', client);
      await repo.insertDeliveryLog({
        notification_id: n.id,
        tenant_id:       n.tenant_id,
        attempt_no:      expectedAttemptCount,
        status:          'not_configured',
        provider:        null,
        error_code:      'no_provider_registered',
      });
      _fireDeliveryAudit(n, 'not_configured');
      summary.failed++;
      return;
    }

    // Execute provider send. Plaintext fields live only in local scope for this call.
    let sendResult = null;
    let thrownClass = null;
    let thrownCode  = null;
    try {
      sendResult = await provider.send({
        recipient: n.recipient,
        subject:   n.subject,
        body:      n.body,
        context:   n.context,
      });
    } catch (err) {
      thrownClass = _classifyThrownError(err);
      thrownCode  = err.code ? String(err.code).slice(0, 60) : 'PROVIDER_EXCEPTION';
    }
    // Clear local plaintext references as early as possible.
    // (sendResult may still hold a provider reference — cleared after use below.)

    if (!thrownClass && sendResult && sendResult.ok) {
      // ── Success ──────────────────────────────────────────────────────────
      const providerRef = sendResult.provider_ref || sendResult.message_id || null;
      const msgId       = providerRef ? String(providerRef).slice(0, 255) : null;
      sendResult = null; // clear immediately

      const delivered = await repo.markNotificationDelivered(
        n.id, workerId, expectedAttemptCount, msgId, client
      );
      if (!delivered) {
        // Transition returned null — another worker already owns this row.
        logger.warn({ notificationId: n.id, workerId, attemptNo: expectedAttemptCount }, '[notif] delivery lost ownership');
        summary.skipped++;
        return;
      }

      await repo.insertDeliveryLog({
        notification_id: n.id,
        tenant_id:       n.tenant_id,
        attempt_no:      expectedAttemptCount,
        status:          'delivered',
        provider:        n.channel,
        provider_ref:    msgId,
      });
      logger.info({
        notificationId: n.id,
        channel:        n.channel,
        attemptNo:      expectedAttemptCount,
        workerId,
        providerRef:    msgId,
      }, '[notif] delivered');
      _fireDeliveryAudit(n, 'delivered');
      summary.delivered++;
      return;
    }

    // ── Failure — classify and decide retry vs terminal ───────────────────
    let errClass, errCode;
    if (thrownClass) {
      errClass = thrownClass;
      errCode  = thrownCode;
    } else {
      errClass = _classifyProviderResult(sendResult);
      errCode  = sendResult && sendResult.error ? String(sendResult.error).slice(0, 60) : 'provider_rejected';
    }
    sendResult = null; // clear provider response — never persisted

    const canRetry = errClass !== 'permanent' && begun.attempt_count < begun.max_attempts;

    if (canRetry) {
      const nextAttemptAt = _nextAttemptAt(expectedAttemptCount);
      const retried = await repo.markNotificationRetry(
        n.id, workerId, expectedAttemptCount, nextAttemptAt, client
      );
      if (!retried) { summary.skipped++; return; } // lost ownership

      await repo.insertDeliveryLog({
        notification_id: n.id,
        tenant_id:       n.tenant_id,
        attempt_no:      expectedAttemptCount,
        status:          'failed',
        provider:        n.channel,
        error_code:      errCode,
        retryable:       true,
      });
      logger.info({
        notificationId: n.id,
        channel:        n.channel,
        attemptNo:      expectedAttemptCount,
        workerId,
        retryable:      true,
        errCode,
        nextAttemptAt,
      }, '[notif] retrying');
      summary.retried++;
    } else {
      const failureClass = errClass === 'permanent' ? 'permanent' : 'exhausted';
      const failed = await repo.markNotificationFailed(
        n.id, workerId, expectedAttemptCount, failureClass, client
      );
      if (!failed) { summary.skipped++; return; } // lost ownership

      await repo.insertDeliveryLog({
        notification_id: n.id,
        tenant_id:       n.tenant_id,
        attempt_no:      expectedAttemptCount,
        status:          'failed',
        provider:        n.channel,
        error_code:      errCode,
        retryable:       false,
      });
      logger.info({
        notificationId: n.id,
        channel:        n.channel,
        attemptNo:      expectedAttemptCount,
        workerId,
        retryable:      false,
        failureClass,
        errCode,
      }, '[notif] terminal failure');
      _fireDeliveryAudit(n, 'failed');
      summary.failed++;
    }
  }

  function _fireDeliveryAudit(n, status) {
    // Fire-and-forget — audit failure must never block the retry loop or affect
    // the summary counters. Wraps both synchronous throws and non-Promise returns.
    try {
      const ctx = { tenantId: n.tenant_id, propertyId: n.property_id || null, requestId: null, actorId: null };
      const p = eventBus.publish(makeEvent({
        type:          'notification.delivery_attempted',
        aggregateType: 'notification',
        aggregateId:   n.id,
        payload:       { status, channel: n.channel },
        ctx,
      }));
      if (p && typeof p.catch === 'function') {
        p.catch((e) => {
          logger.warn({ notificationId: n.id, tenantId: n.tenant_id, event: 'notification.delivery_attempted',
                        errCode: e && e.code, errMsg: e && e.message },
            '[notif] delivery-audit publish failed');
        });
      }
    } catch (e) {
      logger.warn({ notificationId: n.id, tenantId: n.tenant_id, event: 'notification.delivery_attempted',
                    errCode: e && e.code, errMsg: e && e.message },
        '[notif] delivery-audit publish failed');
    }
  }

  return { requestNotification, findById, list, sendPending, registerProvider, _renderTemplate: renderTemplate };
}

module.exports = { buildNotificationService };
