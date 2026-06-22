'use strict';

/**
 * InvoiceEngine - proforma + final invoice generation with strict balancing
 * and immutability after closure.
 *
 *   - generateProforma: a non-binding snapshot (for agents/DMCs/guest preview).
 *   - finalize: STRICT - payments must EXACTLY equal the folio total (balance
 *     == 0), else 'invoice_not_balanced'. On success the invoice is FINAL +
 *     locked and the folio is CLOSED (immutable - further charges/voids fail).
 *
 * Emits: invoice.finalized.
 */

const crypto = require('crypto');
const { INVOICE_STATUS } = require('../models/FolioModel');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildInvoiceEngine({ repo, folioEngine, eventBus, numberGen } = {}) {
  if (!repo) throw new Error('InvoiceEngine: repo required');
  if (!folioEngine) throw new Error('InvoiceEngine: folioEngine required');
  const nextNumber = numberGen || (() => 'INV-' + crypto.randomUUID().slice(0, 8).toUpperCase());

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType: 'invoice', aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt financial state */ }
  }

  async function snapshot(ctx, folioId) {
    const stmt = await folioEngine.getStatement(ctx, folioId);
    const lines = stmt.items.filter((i) => !i.voided)
      .map((i) => ({ type: i.type, description: i.description, quantity: i.quantity, amount: i.amount }));
    return { folio: stmt.folio, lines, total: stmt.totals.chargesTotal, paid: stmt.totals.paymentsTotal, balance: stmt.totals.balance };
  }

  return {
    async generateProforma(ctx, { folioId } = {}) {
      const propertyId = ctx && ctx.propertyId;
      if (!propertyId) throw new Error('property_required');
      const existing = await repo.getInvoiceByFolio(folioId);
      if (existing && existing.status === INVOICE_STATUS.FINAL) return existing;   // already final
      const s = await snapshot(ctx, folioId);
      const inv = {
        invoiceId: (existing && existing.invoiceId) || crypto.randomUUID(),
        folioId, propertyId, number: (existing && existing.number) || nextNumber(),
        status: INVOICE_STATUS.PROFORMA, locked: false,
        lines: s.lines, total: s.total, paid: s.paid, balance: s.balance,
        issuedAt: new Date().toISOString(), finalizedAt: null
      };
      return repo.upsertInvoice(inv);
    },

    async finalize(ctx, { folioId } = {}) {
      const propertyId = ctx && ctx.propertyId;
      if (!propertyId) throw new Error('property_required');
      const existing = await repo.getInvoiceByFolio(folioId);
      if (existing && existing.status === INVOICE_STATUS.FINAL) throw new Error('invoice_already_final');

      const s = await snapshot(ctx, folioId);
      if (s.balance !== 0) throw new Error('invoice_not_balanced');   // STRICT: payments must match total exactly

      const inv = {
        invoiceId: (existing && existing.invoiceId) || crypto.randomUUID(),
        folioId, propertyId, number: (existing && existing.number) || nextNumber(),
        status: INVOICE_STATUS.FINAL, locked: true,
        lines: s.lines, total: s.total, paid: s.paid, balance: 0,
        issuedAt: (existing && existing.issuedAt) || new Date().toISOString(),
        finalizedAt: new Date().toISOString()
      };
      const saved = await repo.upsertInvoice(inv);
      await folioEngine.closeFolio(ctx, folioId);                     // folio becomes immutable
      await emit('invoice.finalized', saved.invoiceId,
        { invoice_id: saved.invoiceId, folio_id: folioId, number: saved.number, total: saved.total, property_id: propertyId }, ctx);
      return saved;
    },

    async getInvoice(ctx, folioId) { return repo.getInvoiceByFolio(folioId); }
  };
}

module.exports = { buildInvoiceEngine };
