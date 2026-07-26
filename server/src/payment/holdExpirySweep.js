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
 * so hold expiry only affects PMS availability, not the ARI sold counter.
 *
 * Phase 63 P0-6: the reservation being cancelled is now PENDING_PAYMENT (it was
 * INQUIRY, which the PMS availability engine did not count as consumed — so an
 * expiring hold released inventory that had never been taken in the first
 * place, and concurrent guests all saw the same last room as free).
 *
 * Phase 63 P0-8: the 'pending_payment' -> 'failed' transition is an atomic
 * compare-and-set, so the sweep and confirmBooking can no longer both act on
 * the same hold.
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
        // Phase 63 P0-8: claim the hold with an ATOMIC compare-and-set.
        //
        // The old read-then-upsert was not a CAS: confirmBooking could read
        // 'pending', the sweep could then flip the row and cancel the PMS
        // reservation, and confirm would still charge the guest. Now exactly
        // one of {sweep, confirm} wins; the loser gets null and stands down.
        if (typeof paymentStateStore.transitionPending === 'function') {
          const claimed = await paymentStateStore.transitionPending(
            hold.reservation_id, 'failed', { failed_at: new Date().toISOString() }, holdCtx
          );
          if (!claimed) continue; // confirmBooking (or another sweep) got there first
        } else {
          // Legacy store without CAS support — preserve the old best-effort path.
          const current = await paymentStateStore.getByReservationId(hold.reservation_id, holdCtx);
          if (!current || current.payment_status !== 'pending_payment') continue;
          await paymentStateStore.upsert({
            reservation_id: hold.reservation_id,
            payment_status: 'failed',
            failed_at:      new Date().toISOString(),
          }, holdCtx);
        }

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
