'use strict';

/**
 * Invoice commands (Phase 7 / C9).
 *
 *   pms.invoice.issue_from_folio  (accountingSensitive)
 *   pms.invoice.void               (accountingSensitive)
 *
 * Issuing requires folio.balance == 0. Numbering format is configurable
 * via the settings catalog key `invoice.numbering.format`; default
 * `{PROPCODE}-INV-{YYYY}-{NNNNNN}`. Invoices are immutable except for
 * VOID transition (which records a reason and is itself audited).
 */

const { makeEvent } = require('../../core/event');

function pad6(n) { const s = String(n); return s.length >= 6 ? s : '0'.repeat(6 - s.length) + s; }

function formatNumber(template, { propCode, year, seq }) {
  return String(template || '{PROPCODE}-INV-{YYYY}-{NNNNNN}')
    .replace('{PROPCODE}', propCode || 'P')
    .replace('{YYYY}', String(year))
    .replace('{NNNNNN}', pad6(seq));
}

function makeInvoiceCommands({ folioRepo, pmsRepo, settingsService, ledgerService }) {
  if (!folioRepo) throw new Error('folioRepo required');
  if (!pmsRepo)   throw new Error('pmsRepo required');
  const cmds = [];

  cmds.push({
    name: 'pms.invoice.issue_from_folio',
    aggregateType: 'invoice',
    permission: 'invoice.write',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId)   return { ok: false, error: 'tenant_required' };
      if (!ctx.propertyId) return { ok: false, error: 'property_required' };
      if (!input.folio_id) return { ok: false, error: 'folio_id_required' };
      const folio = await folioRepo.findFolioById(ctx.tenantId, input.folio_id);
      if (!folio)                       return { ok: false, error: 'folio_not_found' };
      if (folio.property_id !== ctx.propertyId) return { ok: false, error: 'folio_property_mismatch' };
      if (folio.status === 'VOIDED')    return { ok: false, error: 'folio_voided' };
      if (Number(folio.balance) !== 0)  return { ok: false, error: 'folio_has_balance',
                                                   detail: 'balance=' + folio.balance };

      const year = (ctx.businessDate ? new Date(ctx.businessDate) : new Date()).getUTCFullYear();
      const property = await pmsRepo.findPropertyById(ctx.tenantId, ctx.propertyId);
      const seq = await folioRepo.bumpInvoiceCounter({
        tenantId: ctx.tenantId, propertyId: ctx.propertyId, year });
      let template = '{PROPCODE}-INV-{YYYY}-{NNNNNN}';
      if (settingsService) {
        try {
          const v = await settingsService.get('invoice', 'numbering.format', { ctx, default: template });
          if (typeof v === 'string' && v.length > 0) template = v;
        } catch (_) { /* fall back to default */ }
      }
      const number = formatNumber(template, { propCode: property && property.code || 'P', year, seq });

      const total = Math.abs(Number(folio.total_charges));
      const tax   = 0;     // tax breakdown computed Phase 8 from folio_lines.tax_amount

      // Phase 8 bridge: an issued invoice MUST produce a balanced ledger
      // effect (debit Accounts Receivable, credit Revenue via the map). When
      // a ledgerService is wired, we pre-flight the mapping + cost center
      // BEFORE persisting the invoice so a missing mapping rejects cleanly
      // (no orphan invoice). Cost center comes from the request or the folio.
      const costCenterId = input.cost_center_id || folio.cost_center_id || null;
      if (ledgerService && total > 0) {
        const pf = await ledgerService.resolveForEvent({ eventType: 'invoice.issued', costCenterId, ctx });
        if (!pf.ok) return pf;
      }

      const inv = await folioRepo.insertInvoice({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId,
        folio_id: folio.id, invoice_number: number, status: 'ISSUED',
        currency: folio.currency || 'LKR',
        total_amount: total, tax_amount: tax, balance: 0,
        bill_to_guest_id: folio.guest_id || null,
        business_date: ctx.businessDate || folio.business_date,
        payload: { folio_number: folio.folio_number },
        cost_center_id: costCenterId,
        created_by: ctx.actorId
      });

      // Post the AR/Revenue ledger batch. Mapping + cost center were already
      // validated above, so the only residual failures are infrastructural.
      let ledgerBatchId = null;
      if (ledgerService && total > 0) {
        const led = await ledgerService.postForEvent({
          eventType: 'invoice.issued', entryType: 'INVOICE', amount: total,
          referenceType: 'invoice', referenceId: inv.id, costCenterId,
          currency: inv.currency, ctx });
        if (!led.ok) return { ok: false, error: 'ledger_post_failed', detail: led.error };
        ledgerBatchId = led.batchId || null;
      }

      return { ok: true, result: { id: inv.id, invoice_number: number, status: 'ISSUED',
                                   ledger_batch_id: ledgerBatchId },
               events: [
                 makeEvent({ type: 'invoice.issued', aggregateType: 'invoice',
                   aggregateId: inv.id,
                   payload: { invoice_number: number, folio_id: folio.id,
                              total_amount: total, currency: inv.currency,
                              business_date: inv.business_date }, ctx }),
                 makeEvent({ type: 'invoice.paid', aggregateType: 'invoice',
                   aggregateId: inv.id,
                   payload: { invoice_number: number, business_date: inv.business_date }, ctx })
               ]};
    }
  });

  cmds.push({
    name: 'pms.invoice.void',
    aggregateType: 'invoice',
    permission: 'invoice.void',
    accountingSensitive: true,
    async handler(input, ctx) {
      if (!ctx.tenantId) return { ok: false, error: 'tenant_required' };
      if (!input.invoice_id) return { ok: false, error: 'invoice_id_required' };
      if (!input.reason)     return { ok: false, error: 'reason_required' };
      const before = await folioRepo.findInvoiceById(ctx.tenantId, input.invoice_id);
      if (!before) return { ok: false, error: 'invoice_not_found' };
      if (before.status !== 'ISSUED') return { ok: false, error: 'invalid_transition',
                                                  detail: 'from ' + before.status };
      const updated = await folioRepo.voidInvoice(ctx.tenantId, input.invoice_id, input.reason);
      return { ok: true, result: { id: updated.id, status: updated.status },
               events: [ makeEvent({ type: 'invoice.voided', aggregateType: 'invoice',
                 aggregateId: updated.id,
                 payload: { invoice_number: updated.invoice_number, reason: input.reason,
                            business_date: ctx.businessDate || updated.business_date }, ctx }) ]};
    }
  });

  return cmds;
}

module.exports = { makeInvoiceCommands, formatNumber };
