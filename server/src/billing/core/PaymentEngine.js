'use strict';

/**
 * PaymentEngine - records settlements against a folio. Split payments are
 * allowed (cash/card/credit/...). The STRICT balancing rule (payments must
 * exactly match the invoice total) is enforced at invoice finalization
 * (InvoiceEngine), not here - this engine just records valid payments.
 *
 * Emits: payment.received.
 */

const { makePayment } = require('../models/FolioModel');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildPaymentEngine({ repo, folioEngine, eventBus } = {}) {
  if (!repo) throw new Error('PaymentEngine: repo required');
  if (!folioEngine) throw new Error('PaymentEngine: folioEngine required');

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType: 'payment', aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt financial state */ }
  }

  return {
    async recordPayment(ctx, { folioId, method, amount, reference } = {}) {
      const propertyId = ctx && ctx.propertyId;
      if (!propertyId) throw new Error('property_required');
      const folio = await repo.getFolio(propertyId, folioId);
      if (!folio) throw new Error('folio_not_found');
      const payment = makePayment({ folioId, method, amount, reference });
      const saved = await repo.insertPayment(payment);
      await emit('payment.received', saved.paymentId,
        { payment_id: saved.paymentId, folio_id: folioId, method: saved.method, amount: saved.amount, property_id: propertyId }, ctx);
      const balance = await folioEngine.getBalance(ctx, folioId);
      return { payment: saved, balance };
    }
  };
}

module.exports = { buildPaymentEngine };
