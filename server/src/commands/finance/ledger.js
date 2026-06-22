'use strict';

/**
 * Ledger commands (Phase 8).
 *
 *   finance.ledger.post      - post a balanced batch of explicit entries
 *   finance.ledger.validate  - check balance only (no mutation)
 *   finance.ledger.revert    - reverse a posted batch (admin only)
 *
 * The actual balance enforcement, idempotency, property isolation and domain
 * events all live in ledgerService - these handlers are thin adapters. The
 * command bus already records a command.* audit row for every dispatch, so
 * the "write audit event" requirement is satisfied even for rejected posts.
 */

function makeLedgerCommands({ ledgerService }) {
  if (!ledgerService) throw new Error('ledgerService required');
  const cmds = [];

  cmds.push({
    name: 'finance.ledger.post',
    aggregateType: 'ledger',
    permission: 'ledger.write',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId || !ctx.propertyId) return { ok: false, error: 'tenant_and_property_required' };
      if (!input.reference_type || !input.reference_id) return { ok: false, error: 'reference_required' };
      if (!Array.isArray(input.entries) || input.entries.length === 0) return { ok: false, error: 'entries_required' };
      const out = await ledgerService.postEntryBatch({
        entryType: input.entry_type || 'ADJUSTMENT',
        referenceType: input.reference_type, referenceId: input.reference_id,
        currency: input.currency, entries: input.entries, ctx
      });
      if (!out.ok) return out;
      return { ok: true, result: { batch_id: out.batchId, idempotent: !!out.idempotent,
                                   entry_count: out.entries.length } };
    }
  });

  cmds.push({
    name: 'finance.ledger.validate',
    aggregateType: 'ledger',
    permission: 'ledger.read',
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!Array.isArray(input.entries)) return { ok: false, error: 'entries_required' };
      const bal = ledgerService.validateBalance(input.entries);
      return { ok: true, result: bal };
    }
  });

  cmds.push({
    name: 'finance.ledger.revert',
    aggregateType: 'ledger',
    permission: 'ledger.revert',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.batch_id) return { ok: false, error: 'batch_id_required' };
      const out = await ledgerService.rollbackBatch({ batchId: input.batch_id, ctx });
      if (!out.ok) return out;
      return { ok: true, result: { reversal_batch_id: out.reversalBatchId, reverses: out.reverses } };
    }
  });

  return cmds;
}

module.exports = { makeLedgerCommands };
