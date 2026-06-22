'use strict';

/**
 * TaxEngine - pure VAT + service-charge computation, per-property, with
 * inclusive/exclusive pricing support.
 *
 * Config: { vatPct, serviceChargePct, inclusive }. Service charge applies to
 * the net; VAT applies to (net + service charge) - the common hospitality
 * order. All amounts rounded to 2 dp.
 */

const { round2 } = require('../models/FolioModel');

const DEFAULT_CONFIG = Object.freeze({ vatPct: 0, serviceChargePct: 0, inclusive: false });

/**
 * @param {number} amount  exclusive: the net charge; inclusive: the gross.
 * @returns {{ net, serviceCharge, tax, gross }}
 */
function compute(amount, config = DEFAULT_CONFIG) {
  const vat = Number(config.vatPct || 0) / 100;
  const sc = Number(config.serviceChargePct || 0) / 100;
  const a = Number(amount) || 0;

  if (config.inclusive) {
    // a (gross) = net * (1 + sc) * (1 + vat)
    const net = round2(a / ((1 + sc) * (1 + vat)));
    const serviceCharge = round2(net * sc);
    const tax = round2((net + serviceCharge) * vat);
    const gross = round2(net + serviceCharge + tax);
    return { net, serviceCharge, tax, gross };
  }
  const net = round2(a);
  const serviceCharge = round2(net * sc);
  const tax = round2((net + serviceCharge) * vat);
  const gross = round2(net + serviceCharge + tax);
  return { net, serviceCharge, tax, gross };
}

module.exports = { compute, DEFAULT_CONFIG };
