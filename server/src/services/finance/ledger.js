'use strict';

/**
 * Ledger service (Phase 8 - double-entry backbone).
 *
 * The single authority for turning a financial event into BALANCED ledger
 * entries. Nothing else in the system is allowed to write ledger rows.
 *
 *   const ledgerService = buildLedgerService({ ledgerRepo, revenueMapRepo, costCenterRepo, eventBus });
 *
 * Hard rules enforced here (Phase 8 spec):
 *   - Every batch MUST balance: SUM(debit) === SUM(credit). Otherwise it is
 *     rejected and `ledger.imbalance_rejected` is emitted.
 *   - Every event-driven posting MUST resolve through the revenue_posting_map.
 *     A missing mapping is a HARD FAIL (no fallback).
 *   - A cost center is REQUIRED for revenue-bearing postings (C11), and it
 *     must belong to the command's property (no cross-property leakage).
 *   - Postings are idempotent per (reference_type, reference_id, entry_type):
 *     re-posting the same financial fact is a no-op that returns the existing
 *     batch.
 *
 * Domain events emitted (note: the kernel's makeEvent enforces a single-dot
 * `aggregate.verb` type, so the spec's dotted names map as follows):
 *   ledger.entry.created     -> ledger.entry_created
 *   ledger.batch.posted      -> ledger.batch_posted
 *   ledger.imbalance_rejected
 *   revenue_mapped           -> revenue.mapped
 */

const { makeEvent } = require('../../core/event');
const logger = require('../../config/logger');

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function buildLedgerService({ ledgerRepo, revenueMapRepo, costCenterRepo, eventBus } = {}) {
  if (!ledgerRepo) throw new Error('ledgerRepo required');

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus) return;
    try {
      await eventBus.publish(makeEvent({
        type, aggregateType: 'ledger', aggregateId: String(aggregateId), payload, ctx
      }));
    } catch (err) {
      logger.error({ err, type }, '[ledgerService] event publish failed');
    }
  }

  /**
   * Sum the debit/credit legs and report whether they balance.
   * Pure - no side effects, safe for `finance.ledger.validate`.
   */
  function validateBalance(entries) {
    let debit = 0, credit = 0;
    for (const e of (entries || [])) {
      debit  += Number(e.debit_amount  || 0);
      credit += Number(e.credit_amount || 0);
    }
    debit = round2(debit); credit = round2(credit);
    return { balanced: debit === credit, total_debit: debit, total_credit: credit };
  }

  /**
   * Post a set of pre-built entries as one balanced batch.
   * Rejects (and records) any imbalance. Idempotent by reference + entry_type.
   */
  async function postEntryBatch({ entryType, referenceType, referenceId, currency, entries, ctx }) {
    const tenantId = ctx && ctx.tenantId;
    const propertyId = ctx && ctx.propertyId;
    if (!tenantId || !propertyId) return { ok: false, error: 'tenant_and_property_required' };
    if (!referenceType || !referenceId) return { ok: false, error: 'reference_required' };
    if (!Array.isArray(entries) || entries.length === 0) return { ok: false, error: 'no_entries' };

    // Property isolation: an entry may not be tagged to another property.
    for (const e of entries) {
      if (e.property_id && e.property_id !== propertyId) {
        return { ok: false, error: 'cross_property_entry' };
      }
    }

    const bal = validateBalance(entries);
    if (!bal.balanced || bal.total_debit === 0) {
      await emit('ledger.imbalance_rejected', referenceId, {
        reference_type: referenceType, reference_id: referenceId, entry_type: entryType,
        total_debit: bal.total_debit, total_credit: bal.total_credit
      }, ctx);
      return { ok: false, error: 'ledger_imbalance',
               detail: 'debit=' + bal.total_debit + ' credit=' + bal.total_credit };
    }

    // Idempotency: a financial fact maps to exactly one batch of a given type.
    const existing = await ledgerRepo.findLedgerByReference(tenantId, referenceType, referenceId);
    const sameType = existing.filter((e) => e.entry_type === entryType);
    if (sameType.length > 0) {
      return { ok: true, idempotent: true, batchId: sameType[0].batch_id, entries: sameType };
    }

    const cur = currency || 'LKR';
    const batch = await ledgerRepo.insertLedgerBatch({
      tenant_id: tenantId, property_id: propertyId, entry_type: entryType,
      reference_type: referenceType, reference_id: referenceId, currency: cur,
      total_debit: bal.total_debit, total_credit: bal.total_credit, created_by: ctx.actorId || null
    });

    const written = [];
    for (const e of entries) {
      const row = await ledgerRepo.insertLedgerEntry({
        tenant_id: tenantId, property_id: propertyId, batch_id: batch.id, entry_type: entryType,
        reference_type: referenceType, reference_id: referenceId,
        cost_center_id: e.cost_center_id || null, account_code: e.account_code,
        debit_amount: round2(e.debit_amount || 0), credit_amount: round2(e.credit_amount || 0),
        currency: cur
      });
      written.push(row);
      await emit('ledger.entry_created', row.id, {
        batch_id: batch.id, account_code: row.account_code,
        debit_amount: Number(row.debit_amount), credit_amount: Number(row.credit_amount),
        cost_center_id: row.cost_center_id, reference_type: referenceType, reference_id: referenceId
      }, ctx);
    }

    await emit('ledger.batch_posted', batch.id, {
      reference_type: referenceType, reference_id: referenceId, entry_type: entryType,
      total_debit: bal.total_debit, total_credit: bal.total_credit,
      entry_count: written.length, currency: cur
    }, ctx);

    return { ok: true, batchId: batch.id, entries: written };
  }

  /**
   * Resolve a PMS operational event through the revenue_posting_map and the
   * cost-center rules WITHOUT writing anything. Phase 7 commands call this as
   * a pre-flight so they can reject (and avoid mutating their own aggregate)
   * before any ledger row is attempted. Returns { ok, map, costCenterId }.
   */
  async function resolveForEvent({ eventType, costCenterId, ctx }) {
    const tenantId = ctx && ctx.tenantId;
    const propertyId = ctx && ctx.propertyId;
    if (!tenantId || !propertyId) return { ok: false, error: 'tenant_and_property_required' };
    if (!revenueMapRepo) return { ok: false, error: 'revenue_map_unavailable' };

    const map = await revenueMapRepo.findRevenueMap(tenantId, propertyId, eventType);
    if (!map) return { ok: false, error: 'revenue_mapping_missing', detail: 'event_type=' + eventType };

    // C11: cost center is REQUIRED. Prefer an explicit caller value, then the
    // map's default. It must exist, be active, and live in THIS property.
    const ccId = costCenterId || map.cost_center_id || null;
    if (!ccId) return { ok: false, error: 'cost_center_required' };
    if (costCenterRepo) {
      const cc = await costCenterRepo.findCostCenterById(tenantId, ccId);
      if (!cc) return { ok: false, error: 'cost_center_not_found' };
      if (cc.property_id !== propertyId) return { ok: false, error: 'cost_center_property_mismatch' };
      if (cc.is_active === false) return { ok: false, error: 'cost_center_inactive' };
    }
    return { ok: true, map, costCenterId: ccId };
  }

  /**
   * Resolve a PMS operational event through the revenue_posting_map into a
   * balanced 2-leg batch (debit_account / credit_account), then post it.
   *
   * @param {string} eventType    map key, e.g. 'invoice.issued'
   * @param {string} entryType    INVOICE | PAYMENT | VOUCHER | ADJUSTMENT
   * @param {number} amount       gross amount; <= 0 is a no-op (skipped)
   * @param {string} referenceType / referenceId   domain anchor
   * @param {string} [costCenterId] overrides the map's cost_center_id
   */
  async function postForEvent({ eventType, entryType, amount, referenceType, referenceId,
                                costCenterId, currency, ctx }) {
    const propertyId = ctx && ctx.propertyId;
    const amt = round2(amount);
    if (!(amt > 0)) return { ok: true, skipped: true, reason: 'zero_amount' };

    const resolved = await resolveForEvent({ eventType, costCenterId, ctx });
    if (!resolved.ok) return resolved;
    const map = resolved.map;
    const ccId = resolved.costCenterId;

    const entries = [
      { account_code: map.debit_account,  debit_amount: amt, credit_amount: 0,   cost_center_id: ccId, property_id: propertyId },
      { account_code: map.credit_account, debit_amount: 0,   credit_amount: amt, cost_center_id: ccId, property_id: propertyId }
    ];

    const posted = await postEntryBatch({
      entryType: entryType || 'ADJUSTMENT', referenceType, referenceId, currency, entries, ctx
    });
    if (!posted.ok) return posted;

    await emit('revenue.mapped', referenceId, {
      source_event: eventType, revenue_type: map.revenue_type,
      debit_account: map.debit_account, credit_account: map.credit_account,
      amount: amt, cost_center_id: ccId, batch_id: posted.batchId,
      reference_type: referenceType, reference_id: referenceId
    }, ctx);

    return Object.assign({ revenue_type: map.revenue_type }, posted);
  }

  /** Reverse a posted batch with an offsetting REVERSAL batch. */
  async function rollbackBatch({ batchId, ctx }) {
    const tenantId = ctx && ctx.tenantId;
    if (!tenantId) return { ok: false, error: 'tenant_required' };
    if (!batchId)  return { ok: false, error: 'batch_id_required' };
    const rev = await ledgerRepo.revertBatch(tenantId, batchId);
    if (!rev) return { ok: false, error: 'batch_not_found_or_already_reverted' };
    await emit('ledger.batch_posted', rev.id, {
      reference_type: 'ledger_batch', reference_id: batchId, entry_type: 'REVERSAL',
      reverses_batch_id: batchId
    }, ctx);
    await emit('ledger.reverted', batchId, { reversal_batch_id: rev.id }, ctx);
    return { ok: true, reversalBatchId: rev.id, reverses: batchId };
  }

  async function getLedgerByReference({ referenceType, referenceId, ctx }) {
    const tenantId = ctx && ctx.tenantId;
    if (!tenantId) return { ok: false, error: 'tenant_required' };
    if (!referenceType || !referenceId) return { ok: false, error: 'reference_required' };
    return { ok: true, entries: await ledgerRepo.findLedgerByReference(tenantId, referenceType, referenceId) };
  }

  return { validateBalance, resolveForEvent, postEntryBatch, postForEvent, rollbackBatch, getLedgerByReference };
}

module.exports = { buildLedgerService, round2 };
