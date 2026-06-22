'use strict';

/**
 * Payment Allocation service (Phase 7 / C8).
 *
 *   allocate({tenantId, folioId, paymentLineId, allocations, businessDate, actorId, oldestFirst})
 *
 * Behaviour:
 *   * Loads the payment line. Refuses non-PAYMENT/REFUND charge types.
 *   * Loads sibling charge lines on the same folio.
 *   * If `allocations` is omitted (auto-distribute), distributes the
 *     payment amount across charges in posted-at order, taking as much
 *     as each charge still needs until the payment is consumed.
 *   * If `allocations` is supplied, honours the explicit list.
 *   * Cross-folio allocation is rejected.
 *   * Returns { ok, allocations:[{id, charge_line_id, amount_allocated}],
 *               unallocated_remainder }.
 *
 * Pure-ish: the folio_lines.amount field already drives folios.balance
 * recomputation in folioRepo.insertFolioLine; allocations are an
 * INFORMATIONAL overlay (which payment paid which charge). Settlement
 * status of a folio is still derived from `balance == 0`.
 */

function buildPaymentAllocationService({ folioRepo, pmsRepo }) {
  if (!folioRepo) throw new Error('folioRepo required');

  async function allocate({ tenantId, folioId, paymentLineId, allocations, businessDate, actorId, oldestFirst }) {
    if (!tenantId || !folioId || !paymentLineId) {
      return { ok: false, error: 'missing_required' };
    }

    const folio = await folioRepo.findFolioById(tenantId, folioId);
    if (!folio) return { ok: false, error: 'folio_not_found' };

    const lines = await folioRepo.listFolioLines(tenantId, folioId);
    const payment = lines.find((l) => l.id === paymentLineId);
    if (!payment)            return { ok: false, error: 'payment_line_not_found' };
    if (payment.folio_id !== folioId) return { ok: false, error: 'payment_folio_mismatch' };
    if (!['PAYMENT','REFUND'].includes(payment.charge_type)) {
      return { ok: false, error: 'line_is_not_a_payment' };
    }

    const chargeLines = lines.filter((l) => !['PAYMENT','REFUND'].includes(l.charge_type));
    // Map: how much each charge already received from prior allocations.
    const priorByCharge = new Map();
    for (const c of chargeLines) {
      const prior = await folioRepo.listAllocationsForCharge(tenantId, c.id);
      const sum = prior.reduce((s, a) => s + Number(a.amount_allocated), 0);
      priorByCharge.set(c.id, sum);
    }

    // Payment amount stored as a NEGATIVE number (e.g. -100). Convert to
    // positive available amount.
    const paymentTotal = Math.abs(Number(payment.amount));
    let remaining = paymentTotal;
    const created = [];

    if (Array.isArray(allocations) && allocations.length > 0) {
      // Explicit allocation map.
      for (const a of allocations) {
        if (!a || !a.charge_line_id || !Number.isFinite(a.amount) || a.amount <= 0) {
          return { ok: false, error: 'invalid_allocation_entry' };
        }
        const charge = chargeLines.find((c) => c.id === a.charge_line_id);
        if (!charge) return { ok: false, error: 'charge_line_not_in_folio' };
        const owed = Number(charge.amount) - (priorByCharge.get(charge.id) || 0);
        if (a.amount > owed) return { ok: false, error: 'allocation_exceeds_charge', detail: 'charge=' + charge.id };
        if (a.amount > remaining) return { ok: false, error: 'allocation_exceeds_payment' };
        const rec = await folioRepo.insertPaymentAllocation({
          tenant_id: tenantId, folio_id: folioId,
          payment_line_id: paymentLineId, charge_line_id: charge.id,
          amount_allocated: a.amount, allocated_by: actorId, business_date: businessDate
        });
        created.push(rec);
        remaining -= a.amount;
        priorByCharge.set(charge.id, (priorByCharge.get(charge.id) || 0) + a.amount);
      }
    } else {
      // Auto-distribute oldest-first.
      const orderedCharges = chargeLines.slice().sort((a, b) => {
        if (oldestFirst === false) return 0;
        return (a.posted_at || '').localeCompare(b.posted_at || '');
      });
      for (const c of orderedCharges) {
        if (remaining <= 0) break;
        const owed = Number(c.amount) - (priorByCharge.get(c.id) || 0);
        if (owed <= 0) continue;
        const take = Math.min(owed, remaining);
        const rec = await folioRepo.insertPaymentAllocation({
          tenant_id: tenantId, folio_id: folioId,
          payment_line_id: paymentLineId, charge_line_id: c.id,
          amount_allocated: take, allocated_by: actorId, business_date: businessDate
        });
        created.push(rec);
        remaining -= take;
        priorByCharge.set(c.id, (priorByCharge.get(c.id) || 0) + take);
      }
    }

    return { ok: true, allocations: created, unallocated_remainder: remaining };
  }

  return { allocate };
}

module.exports = { buildPaymentAllocationService };
