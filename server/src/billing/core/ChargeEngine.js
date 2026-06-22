'use strict';

/**
 * ChargeEngine - posts the different kinds of charges onto a folio, applying
 * tax/service-charge via the TaxEngine. Delegates the actual posting to the
 * FolioEngine. Pure orchestration of charge composition.
 */

const tax = require('./TaxEngine');
const { ITEM_TYPE } = require('../models/FolioModel');

function buildChargeEngine({ folioEngine } = {}) {
  if (!folioEngine) throw new Error('ChargeEngine: folioEngine required');

  async function postWithTax(ctx, folioId, baseType, description, base, taxConfig) {
    const t = tax.compute(base, taxConfig || tax.DEFAULT_CONFIG);
    const lines = [];
    lines.push(await folioEngine.addCharge(ctx, { folioId, type: baseType, description, amount: t.net }));
    if (t.serviceCharge > 0) lines.push(await folioEngine.addCharge(ctx, { folioId, type: ITEM_TYPE.SERVICE_CHARGE, description: 'Service charge', amount: t.serviceCharge }));
    if (t.tax > 0) lines.push(await folioEngine.addCharge(ctx, { folioId, type: ITEM_TYPE.TAX, description: 'VAT', amount: t.tax }));
    return { lines, breakdown: t };
  }

  return {
    /** Daily (or hourly) room rate posting. quantity = nights (or hours). */
    async postRoomCharge(ctx, { folioId, quantity = 1, unitRate, taxConfig } = {}) {
      if (!(Number(unitRate) >= 0)) throw new Error('invalid_unit_rate');
      const base = Number(unitRate) * Number(quantity);
      // Post the room line with its quantity/unit, then tax/service on the net.
      const t = tax.compute(base, taxConfig || tax.DEFAULT_CONFIG);
      const lines = [];
      lines.push(await folioEngine.addCharge(ctx, { folioId, type: ITEM_TYPE.ROOM, description: 'Room charge', amount: t.net, quantity, unitAmount: unitRate }));
      if (t.serviceCharge > 0) lines.push(await folioEngine.addCharge(ctx, { folioId, type: ITEM_TYPE.SERVICE_CHARGE, description: 'Service charge', amount: t.serviceCharge }));
      if (t.tax > 0) lines.push(await folioEngine.addCharge(ctx, { folioId, type: ITEM_TYPE.TAX, description: 'VAT', amount: t.tax }));
      return { lines, breakdown: t };
    },

    /** Extra (minibar, POS, services). taxable defaults true. */
    async postExtra(ctx, { folioId, description, amount, taxConfig, taxable = true } = {}) {
      if (!taxable) {
        return { lines: [await folioEngine.addCharge(ctx, { folioId, type: ITEM_TYPE.EXTRA, description: description || 'Extra', amount })] };
      }
      return postWithTax(ctx, folioId, ITEM_TYPE.EXTRA, description || 'Extra', amount, taxConfig);
    },

    /** Adjustment: DISCOUNT (negative), COMP, or CORRECTION. */
    async applyAdjustment(ctx, { folioId, amount, reason, kind = 'ADJUSTMENT' } = {}) {
      const type = kind === 'DISCOUNT' ? ITEM_TYPE.DISCOUNT : ITEM_TYPE.ADJUSTMENT;
      const signed = kind === 'DISCOUNT' ? -Math.abs(Number(amount)) : Number(amount);
      return folioEngine.addCharge(ctx, { folioId, type, description: reason || kind, amount: signed });
    }
  };
}

module.exports = { buildChargeEngine };
