'use strict';

/**
 * Payment Allocation commands (Phase 7 / C8).
 */

const { makeEvent } = require('../../core/event');

// Phase 64 P1-7: folioRepo is injected so the command can verify that the folio
// belongs to ctx.propertyId before allocating. It is optional so existing
// callers that do not supply it keep working (the guard then degrades to the
// property_context_required check only, and says so).
function makePaymentAllocationCommands({ paymentAllocationService, ledgerService, folioRepo }) {
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

      // Phase 64 P1-7 — property isolation.
      // The folio was resolved by tenant only, while the ledger legs are stamped
      // with ctx.propertyId. A caller on property A allocating property B's
      // folio payment produced ledger rows booked to A against a B folio, and
      // the ledger service's own cross-property guard could not catch it because
      // it only inspects entries it built from ctx itself.
      if (!ctx.propertyId) return { ok: false, error: 'property_context_required' };
      if (folioRepo) {
        const folio = await folioRepo.findFolioById(ctx.tenantId, input.folio_id);
        if (!folio) return { ok: false, error: 'folio_not_found' };
        if (folio.property_id && folio.property_id !== ctx.propertyId) {
          return { ok: false, error: 'property_access_denied', detail: 'folio' };
        }
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
