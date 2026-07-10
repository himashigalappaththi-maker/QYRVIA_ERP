'use strict';

/**
 * Phase 56 — Booking Confirmation Delivery Service.
 *
 * Persistent outbox/worker model for delivering booking confirmation notices.
 *
 * API:
 *   queueDelivery({ tenantId, propertyId, reservationId, confirmationNumber,
 *                   channel, recipient, context, notificationType? }, ctx)
 *     -> { ok, id?, deduped? }
 *     Inserts one pending row. Idempotent: a duplicate dedup_key on the same
 *     tenant returns { ok: true, deduped: true } without a second insert.
 *
 *   processPendingDeliveries({ limit? })
 *     -> { attempted, sent, retryable, permanent, skipped }
 *     Claims pending rows with FOR UPDATE SKIP LOCKED, calls the adapter,
 *     persists success/failure, sets confirmation_sent_at on first success.
 *     Bounded retry: after max_attempts the row becomes permanent_failure.
 *     A delivery failure NEVER cancels or rolls back the booking.
 *
 * Retry delays (exponential, no external dependency):
 *   attempt 1 → +5 min, attempt 2 → +30 min, attempt 3+ → permanent_failure.
 *
 * Dedup key: {reservationId}:{notificationType}:{channel}:{recipient}
 *   A unique DB constraint on (tenant_id, dedup_key) enforces this at write time.
 *
 * Adapter interface (injected via `notificationAdapter`):
 *   adapter.send({ channel, recipient, confirmationNumber, context }) -> { ok, provider_ref?, error? }
 *   Must not throw for retryable errors; throw only for programming errors.
 *   Default: no-op adapter (safe for tests and non-production environments).
 */

const logger = require('../config/logger');

const RETRY_DELAYS_MS = [5 * 60 * 1000, 30 * 60 * 1000]; // 5 min, 30 min

function buildNoOpAdapter() {
  return {
    async send() { return { ok: false, error: 'no_adapter_configured' }; }
  };
}

function buildConfirmationDeliveryService({
  repo,
  notificationAdapter = null,
  setReservationConfirmationSent = null,
  workerId = null,
} = {}) {
  if (!repo) throw new Error('buildConfirmationDeliveryService: repo required');
  const adapter = notificationAdapter || buildNoOpAdapter();
  const wid = workerId || ('cdw-' + Math.random().toString(36).slice(2, 10));

  function buildDedupKey(reservationId, notificationType, channel, recipient) {
    return [reservationId, notificationType, channel, recipient].join(':');
  }

  async function queueDelivery({
    tenantId, propertyId, reservationId, confirmationNumber,
    channel, recipient, context, notificationType,
  }, ctx) {
    const _ctx = ctx || {};
    if (!tenantId && !_ctx.tenantId) return { ok: false, error: 'tenant_required' };
    const tId = tenantId || _ctx.tenantId;
    if (!reservationId) return { ok: false, error: 'reservation_id_required' };
    if (!channel)       return { ok: false, error: 'channel_required' };
    if (!recipient)     return { ok: false, error: 'recipient_required' };

    const nType = notificationType || 'booking_confirmation';
    const dedupKey = buildDedupKey(reservationId, nType, channel, recipient);

    try {
      const row = await repo.insertBookingConfirmationDelivery({
        tenant_id:           tId,
        property_id:         propertyId || _ctx.propertyId || null,
        reservation_id:      reservationId,
        confirmation_number: confirmationNumber || null,
        channel,
        recipient,
        notification_type:   nType,
        context:             context || {},
        dedup_key:           dedupKey,
      });
      logger.info({ tenant_id: tId, reservation_id: reservationId, id: row.id }, '[confirmDelivery] queued');
      return { ok: true, id: row.id };
    } catch (err) {
      // Unique constraint violation on dedup_key = already queued (idempotent).
      if (err && err.code === '23505') {
        logger.info({ tenant_id: tId, reservation_id: reservationId }, '[confirmDelivery] duplicate suppressed');
        return { ok: true, deduped: true };
      }
      logger.error({ err, tenant_id: tId, reservation_id: reservationId }, '[confirmDelivery] queue error');
      return { ok: false, error: 'queue_write_failed' };
    }
  }

  async function processPendingDeliveries({ limit = 25 } = {}) {
    let attempted = 0, sent = 0, retryable = 0, permanent = 0, skipped = 0;

    const rows = await repo.claimPendingConfirmationDeliveries({ limit, workerId: wid });

    for (const row of rows) {
      attempted++;
      const ctx = { tenantId: row.tenant_id, propertyId: row.property_id };

      // Guard: already sent (safety net for stale worker)
      if (row.status === 'sent') { skipped++; continue; }

      let sendResult;
      try {
        sendResult = await adapter.send({
          channel:             row.channel,
          recipient:           row.recipient,
          confirmationNumber:  row.confirmation_number,
          context:             row.context || {},
        });
      } catch (err) {
        sendResult = { ok: false, error: String(err && err.message || err) };
      }

      if (sendResult && sendResult.ok) {
        const sentAt = new Date();
        await repo.markConfirmationDeliveryStatus(row.id, 'sent', {
          sentAt,
          providerRef: sendResult.provider_ref || null,
        });
        // Set confirmation_sent_at on reservation (first success only)
        if (setReservationConfirmationSent) {
          try {
            await setReservationConfirmationSent(row.tenant_id, row.reservation_id, sentAt);
          } catch (e) {
            logger.error({ err: e, reservation_id: row.reservation_id }, '[confirmDelivery] confirmation_sent_at write failed');
          }
        }
        logger.info({ id: row.id, reservation_id: row.reservation_id }, '[confirmDelivery] sent');
        sent++;
      } else {
        const nextCount = (row.attempt_count || 0) + 1;
        const lastError = (sendResult && sendResult.error) || 'unknown_error';

        if (nextCount >= (row.max_attempts || 3)) {
          await repo.markConfirmationDeliveryStatus(row.id, 'permanent_failure', {
            attemptCount: nextCount,
            lastError,
          });
          logger.warn({ id: row.id, reservation_id: row.reservation_id, err: lastError }, '[confirmDelivery] permanent_failure');
          permanent++;
        } else {
          const delayMs = RETRY_DELAYS_MS[nextCount - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
          const nextAttemptAt = new Date(Date.now() + delayMs);
          await repo.markConfirmationDeliveryStatus(row.id, 'retryable_failure', {
            attemptCount: nextCount,
            lastError,
            nextAttemptAt,
          });
          logger.info({ id: row.id, next_attempt_at: nextAttemptAt }, '[confirmDelivery] retryable_failure, will retry');
          retryable++;
        }
      }
    }

    return { attempted, sent, retryable, permanent, skipped };
  }

  return { queueDelivery, processPendingDeliveries };
}

function buildNoOpConfirmationDeliveryService() {
  return {
    async queueDelivery() { return { ok: true, deduped: true }; },
    async processPendingDeliveries() { return { attempted: 0, sent: 0, retryable: 0, permanent: 0, skipped: 0 }; },
  };
}

module.exports = { buildConfirmationDeliveryService, buildNoOpConfirmationDeliveryService, buildNoOpAdapter };
