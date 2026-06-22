'use strict';

/**
 * BillingEngine - facade composing Folio / Charge / Payment / Invoice engines
 * + per-property tax configuration. This is the public billing API.
 *
 * Architecture purity: billing ONLY reads + writes financial records. It holds
 * no reference to the Reservation / Room / Stay engines and never mutates their
 * state. Inputs arrive via explicit calls or via the event subscriber.
 */

const { buildFolioEngine } = require('./FolioEngine');
const { buildChargeEngine } = require('./ChargeEngine');
const { buildPaymentEngine } = require('./PaymentEngine');
const { buildInvoiceEngine } = require('./InvoiceEngine');
const taxEngine = require('./TaxEngine');

function buildBillingEngine({ repo, eventBus, numberGen } = {}) {
  if (!repo) throw new Error('BillingEngine: repo required');
  const folioEngine = buildFolioEngine({ repo, eventBus });
  const chargeEngine = buildChargeEngine({ folioEngine });
  const paymentEngine = buildPaymentEngine({ repo, folioEngine, eventBus });
  const invoiceEngine = buildInvoiceEngine({ repo, folioEngine, eventBus, numberGen });

  const taxByProperty = new Map();
  const taxFor = (propertyId) => taxByProperty.get(propertyId) || taxEngine.DEFAULT_CONFIG;

  return {
    /** Per-property VAT / service-charge / inclusive config. */
    setTaxConfig(ctx, config) {
      if (!ctx || !ctx.propertyId) throw new Error('property_required');
      taxByProperty.set(ctx.propertyId, Object.assign({}, taxEngine.DEFAULT_CONFIG, config));
      return taxFor(ctx.propertyId);
    },
    getTaxConfig(ctx) { return taxFor(ctx && ctx.propertyId); },

    createFolio(ctx, args) { return folioEngine.createFolio(ctx, args); },
    getFolio(ctx, folioId) { return folioEngine.getFolio(ctx, folioId); },
    getFolioByStay(ctx, stayId) { return folioEngine.getFolioByStay(ctx, stayId); },

    postRoomCharge(ctx, args) { return chargeEngine.postRoomCharge(ctx, Object.assign({ taxConfig: taxFor(ctx.propertyId) }, args)); },
    postExtra(ctx, args) { return chargeEngine.postExtra(ctx, Object.assign({ taxConfig: taxFor(ctx.propertyId) }, args)); },
    applyAdjustment(ctx, args) { return chargeEngine.applyAdjustment(ctx, args); },
    voidCharge(ctx, args) { return folioEngine.voidCharge(ctx, args); },

    recordPayment(ctx, args) { return paymentEngine.recordPayment(ctx, args); },

    getBalance(ctx, folioId) { return folioEngine.getBalance(ctx, folioId); },
    getStatement(ctx, folioId) { return folioEngine.getStatement(ctx, folioId); },

    generateProforma(ctx, args) { return invoiceEngine.generateProforma(ctx, args); },
    finalizeInvoice(ctx, args) { return invoiceEngine.finalize(ctx, args); },
    getInvoice(ctx, folioId) { return invoiceEngine.getInvoice(ctx, folioId); }
  };
}

module.exports = { buildBillingEngine };
