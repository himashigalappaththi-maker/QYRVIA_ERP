'use strict';

const logger = require('../config/logger');

/**
 * Phase 55 — Hold expiry sweep.
 *
 * Finds all pending_payment holds that have passed their hold_expires_at,
 * transitions each to 'failed', and cancels the PMS reservation.
 *
 * Correct failure ordering:
 *   1. Mark payment_status = 'failed' (idempotency guard — prevents confirmBooking racing)
 *   2. Dispatch pms.reservation.cancel (failure logged, does NOT undo step 1)
 *
 * ARI adjustSold is NOT called here because initiateBooking does not call
 * adjustSold(+1). The ARI inventory is only adjusted at confirmBooking time,
 * so hold expiry only affects PMS availability (INQUIRY reservation cancelled),
 * not the ARI sold counter.
 *
 * DI:
 *   paymentStateStore  — supports findExpiredHolds(client?) + getByReservationId + upsert
 *   commandBus         — dispatches 'pms.reservation.cancel'
 *   withTenantFn       — optional; when provided, used to scope findExpiredHolds to the
 *                        tenant RLS context (required for DB-backed store under FORCE RLS)
 */
function buildHoldExpirySweep({ paymentStateStore, commandBus, withTenantFn = null, cmds = {} }) {
  if (!paymentStateStore) throw new Error('buildHoldExpirySweep: paymentStateStore required');
  if (!commandBus) throw new Error('buildHoldExpirySweep: commandBus required');

  const CANCEL_CMD = cmds.cancel || 'pms.reservation.cancel';

  async function sweep(ctx) {
    const { tenantId, propertyId } = ctx;

    let expired;
    try {
      if (typeof withTenantFn === 'function') {
        // DB-backed store: findExpiredHolds needs a tenant-scoped client so FORCE RLS
        // (app_current_tenant()) returns the correct tenant's rows.
        expired = await withTenantFn(tenantId, (client) =>
          paymentStateStore.findExpiredHolds(client)
        );
      } else {
        expired = await paymentStateStore.findExpiredHolds();
      }
    } catch (err) {
      logger.error({ err, tenantId }, '[holdExpirySweep] findExpiredHolds failed');
      return { swept: 0, errors: 1 };
    }

    let swept = 0, errors = 0;

    for (const hold of (expired || [])) {
      const holdCtx = {
        tenantId:    hold.tenant_id  || tenantId,
        propertyId:  hold.property_id || propertyId || null,
        actorId:     ctx.actorId     || null,
        requestId:   ctx.requestId   || null,
        roleCodes:   ['system'],
        permissions: ['pms.reservation.write'],
      };

      try {
        // Idempotency: re-read before acting — another sweep or confirmBooking may
        // have already transitioned this record out of pending_payment.
        const current = await paymentStateStore.getByReservationId(hold.reservation_id, holdCtx);
        if (!current || current.payment_status !== 'pending_payment') continue;

        // Step 1: transition to 'failed' BEFORE PMS cancel so confirmBooking cannot race.
        await paymentStateStore.upsert({
          reservation_id: hold.reservation_id,
          payment_status: 'failed',
          failed_at:      new Date().toISOString(),
        }, holdCtx);

        // Step 2: cancel the PMS reservation. Log failure but do not undo step 1.
        try {
          await commandBus.dispatch(CANCEL_CMD, { reservation_id: hold.reservation_id }, holdCtx);
        } catch (cancelErr) {
          logger.warn(
            { err: cancelErr, reservation_id: hold.reservation_id, tenantId },
            '[holdExpirySweep] PMS cancel failed after payment_failed transition — reservation may need manual cleanup'
          );
        }

        swept++;
      } catch (err) {
        logger.error({ err, reservation_id: hold.reservation_id, tenantId }, '[holdExpirySweep] sweep record failed');
        errors++;
      }
    }

    return { swept, errors };
  }

  return { sweep };
}

module.exports = { buildHoldExpirySweep };
