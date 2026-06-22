'use strict';

/**
 * Payment Allocation commands (Phase 7 / C8).
 */

const { makeEvent } = require('../../core/event');

function makePaymentAllocationCommands({ paymentAllocationService, ledgerService }) {
  if (!paymentAllocationService) throw new Error('paymentAllocationService required');

  return [{
    name: 'pms.folio.payment.allocate',
    aggregateType: 'folio',
    permission: 'folio.post',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input || !input.folio_id || !input.payment_line_id) {
        return { ok: false, error: 'folio_id_and_payment_line_id_required' };
      }

      // Phase 8 bridge: pre-flight the cash/AR mapping before allocating.
      const costCenterId = input.cost_center_id || null;
      if (ledgerService) {
        const pf = await ledgerService.resolveForEvent({ eventType: 'folio.payment_allocated', costCenterId, ctx });
        if (!pf.ok) return pf;
      }

      const out = await paymentAllocationService.allocate({
        tenantId: ctx.tenantId,
        folioId: input.folio_id,
        paymentLineId: input.payment_line_id,
        allocations: input.allocations,
        businessDate: ctx.businessDate,
        actorId: ctx.actorId,
        oldestFirst: input.oldest_first !== false
      });
      if (!out.ok) return out;

      // Allocated cash settles AR: debit Cash/Bank, credit Accounts Receivable.
      const allocatedTotal = out.allocations.reduce((s, a) => s + Number(a.amount_allocated || 0), 0);
      let ledgerBatchId = null;
      if (ledgerService && allocatedTotal > 0) {
        const led = await ledgerService.postForEvent({
          eventType: 'folio.payment_allocated', entryType: 'PAYMENT', amount: allocatedTotal,
          referenceType: 'payment_allocation', referenceId: input.payment_line_id,
          costCenterId, currency: input.currency, ctx });
        if (!led.ok) return { ok: false, error: 'ledger_post_failed', detail: led.error };
        ledgerBatchId = led.batchId || null;
      }

      return { ok: true,
               result: {
                 folio_id: input.folio_id,
                 payment_line_id: input.payment_line_id,
                 allocations: out.allocations.map((a) => ({
                   id: a.id, charge_line_id: a.charge_line_id, amount: a.amount_allocated
                 })),
                 unallocated_remainder: out.unallocated_remainder,
                 ledger_batch_id: ledgerBatchId
               },
               events: [
                 makeEvent({ type: 'folio.payment_allocated', aggregateType: 'folio',
                   aggregateId: input.folio_id,
                   payload: { folio_id: input.folio_id, payment_line_id: input.payment_line_id,
                              allocation_count: out.allocations.length,
                              unallocated_remainder: out.unallocated_remainder,
                              business_date: ctx.businessDate || null }, ctx })
               ]};
    }
  }];
}

module.exports = { makePaymentAllocationCommands };
