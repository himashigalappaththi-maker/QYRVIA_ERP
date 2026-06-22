'use strict';

/**
 * Voucher commands (Phase 7 / C6).
 *   pms.voucher.issue
 *   pms.voucher.redeem    (accountingSensitive - attaches to revenue)
 *   pms.voucher.cancel
 *
 * Redemption at check-in is wired in src/index.js via a subscriber on
 * `reservation.checked_in` that consumes an optional `voucher_number`
 * in the original check-in input. For Phase 7 we keep the explicit
 * redeem command independent so vouchers can also be redeemed via the
 * REST surface without going through check-in.
 */

const { makeEvent } = require('../../core/event');

function makeVoucherCommands({ pmsRepo, settingsService, ledgerService }) {
  if (!pmsRepo) throw new Error('pmsRepo required');
  const cmds = [];

  cmds.push({
    name: 'pms.voucher.issue',
    aggregateType: 'voucher',
    permission: 'voucher.write',
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.voucher_number) return { ok: false, error: 'voucher_number_required' };
      if (!input.arrival_date || !input.departure_date) return { ok: false, error: 'date_range_required' };
      if (input.departure_date <= input.arrival_date)   return { ok: false, error: 'invalid_date_range' };
      try {
        let expiresAt = input.expires_at || null;
        if (!expiresAt && settingsService) {
          try {
            const days = await settingsService.get('vouchers', 'default_validity_days',
              { ctx, default: 90 });
            const expiry = new Date(input.departure_date + 'T00:00:00Z');
            expiry.setUTCDate(expiry.getUTCDate() + Number(days || 90));
            expiresAt = expiry.toISOString();
          } catch (_) { /* leave null */ }
        }
        const row = await pmsRepo.insertVoucher({
          tenant_id: ctx.tenantId, property_id: ctx.propertyId,
          voucher_number: input.voucher_number,
          agent_guest_id: input.agent_guest_id || null,
          contract_id: input.contract_id || null,
          guest_name: input.guest_name || null,
          arrival_date: input.arrival_date, departure_date: input.departure_date,
          room_type_id: input.room_type_id || null,
          amount: input.amount || 0, currency: input.currency || 'LKR',
          expires_at: expiresAt,
          payload: input.payload || {},
          created_by: ctx.actorId
        });
        return { ok: true, result: { id: row.id, voucher_number: row.voucher_number, status: row.status }, events: [
          makeEvent({ type: 'voucher.issued', aggregateType: 'voucher', aggregateId: row.id,
            payload: { voucher_number: row.voucher_number, agent_guest_id: row.agent_guest_id,
                       arrival_date: row.arrival_date, departure_date: row.departure_date,
                       amount: row.amount, currency: row.currency,
                       expires_at: row.expires_at, property_id: ctx.propertyId }, ctx })
        ]};
      } catch (e) { return { ok: false, error: 'validation_failed', detail: e.message }; }
    }
  });

  cmds.push({
    name: 'pms.voucher.redeem',
    aggregateType: 'voucher',
    permission: 'voucher.redeem',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.voucher_number) return { ok: false, error: 'voucher_number_required' };
      if (!input.reservation_id) return { ok: false, error: 'reservation_id_required' };
      const v = await pmsRepo.findVoucherByNumber(ctx.tenantId, ctx.propertyId, input.voucher_number);
      if (!v) return { ok: false, error: 'voucher_not_found' };
      if (v.status === 'REDEEMED')  return { ok: false, error: 'voucher_already_redeemed' };
      if (v.status === 'CANCELLED') return { ok: false, error: 'voucher_cancelled' };
      if (v.status === 'EXPIRED')   return { ok: false, error: 'voucher_expired' };
      // Lazy expiry check
      if (v.expires_at && new Date(v.expires_at).getTime() < Date.now()) {
        return { ok: false, error: 'voucher_expired' };
      }
      const res = await pmsRepo.findReservationById(ctx.tenantId, input.reservation_id);
      if (!res) return { ok: false, error: 'reservation_not_found' };

      // Phase 8 bridge: a revenue-impacting redemption MUST resolve through
      // the map (debit Discount/Agent cost, credit Revenue reduction / AR).
      // Pre-flight the mapping + cost center before mutating the voucher.
      const voucherAmount = Math.abs(Number(v.amount || 0));
      const costCenterId = input.cost_center_id || v.cost_center_id || null;
      if (ledgerService && voucherAmount > 0) {
        const pf = await ledgerService.resolveForEvent({ eventType: 'voucher.redeemed', costCenterId, ctx });
        if (!pf.ok) return pf;
      }

      const updated = await pmsRepo.redeemVoucher(ctx.tenantId, v.id, input.reservation_id);

      let ledgerBatchId = null;
      if (ledgerService && voucherAmount > 0) {
        const led = await ledgerService.postForEvent({
          eventType: 'voucher.redeemed', entryType: 'VOUCHER', amount: voucherAmount,
          referenceType: 'voucher', referenceId: updated.id, costCenterId,
          currency: updated.currency, ctx });
        if (!led.ok) return { ok: false, error: 'ledger_post_failed', detail: led.error };
        ledgerBatchId = led.batchId || null;
      }

      return { ok: true, result: { id: updated.id, status: updated.status, reservation_id: input.reservation_id,
                                   ledger_batch_id: ledgerBatchId },
               events: [ makeEvent({ type: 'voucher.redeemed', aggregateType: 'voucher', aggregateId: updated.id,
                 payload: { voucher_number: updated.voucher_number, reservation_id: input.reservation_id,
                            agent_guest_id: updated.agent_guest_id,
                            amount: updated.amount, currency: updated.currency,
                            business_date: ctx.businessDate || null }, ctx }) ]};
    }
  });

  cmds.push({
    name: 'pms.voucher.cancel',
    aggregateType: 'voucher',
    permission: 'voucher.write',
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.voucher_number) return { ok: false, error: 'voucher_number_required' };
      const v = await pmsRepo.findVoucherByNumber(ctx.tenantId, ctx.propertyId, input.voucher_number);
      if (!v) return { ok: false, error: 'voucher_not_found' };
      if (v.status !== 'ISSUED') return { ok: false, error: 'invalid_transition', detail: 'from ' + v.status };
      const updated = await pmsRepo.cancelVoucher(ctx.tenantId, v.id, input.reason || null);
      return { ok: true, result: { id: updated.id, status: updated.status },
               events: [ makeEvent({ type: 'voucher.cancelled', aggregateType: 'voucher', aggregateId: updated.id,
                 payload: { voucher_number: updated.voucher_number, reason: input.reason || null }, ctx }) ]};
    }
  });

  return cmds;
}

module.exports = { makeVoucherCommands };
