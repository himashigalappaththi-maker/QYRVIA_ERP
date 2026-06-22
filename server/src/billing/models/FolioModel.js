'use strict';

/**
 * Billing canonical models (Phase 14 - the first true financial subsystem).
 *
 *   Folio (1 stay = 1 primary folio) -> FolioItem (charges) + Payment
 *   (settlements) -> Invoice (proforma / final, immutable after finalize).
 *
 * Self-contained / additive; JS / CommonJS. Billing NEVER mutates Stay /
 * Reservation / Room state - it only writes financial records.
 */

const crypto = require('crypto');

const FOLIO_STATUS = Object.freeze({ OPEN: 'OPEN', CLOSED: 'CLOSED' });
const INVOICE_STATUS = Object.freeze({ PROFORMA: 'PROFORMA', FINAL: 'FINAL' });
const ITEM_TYPE = Object.freeze({
  ROOM: 'ROOM', EXTRA: 'EXTRA', SERVICE_CHARGE: 'SERVICE_CHARGE',
  TAX: 'TAX', ADJUSTMENT: 'ADJUSTMENT', DISCOUNT: 'DISCOUNT'
});
const PAYMENT_METHOD = Object.freeze({
  CASH: 'CASH', CARD: 'CARD', CREDIT: 'CREDIT', BANK_TRANSFER: 'BANK_TRANSFER', VOUCHER: 'VOUCHER'
});

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function makeFolio(f = {}) {
  if (!f.propertyId) throw new Error('Folio: propertyId required');
  if (!f.stayId)     throw new Error('Folio: stayId required');
  const iso = new Date().toISOString();
  return {
    folioId: f.folioId || crypto.randomUUID(),
    propertyId: String(f.propertyId),
    stayId: String(f.stayId),
    reservationId: f.reservationId || null,
    roomId: f.roomId || null,
    currency: f.currency || 'LKR',
    status: f.status || FOLIO_STATUS.OPEN,
    createdAt: iso,
    updatedAt: iso,
    closedAt: null
  };
}

function makeItem(f = {}) {
  if (!f.folioId) throw new Error('FolioItem: folioId required');
  if (!ITEM_TYPE[f.type]) throw new Error('FolioItem: invalid type ' + JSON.stringify(f.type));
  const qty = f.quantity != null ? Number(f.quantity) : 1;
  const unit = round2(f.unitAmount != null ? f.unitAmount : f.amount);
  return {
    itemId: f.itemId || crypto.randomUUID(),
    folioId: String(f.folioId),
    type: f.type,
    description: f.description || f.type,
    quantity: qty,
    unitAmount: unit,
    amount: round2(f.amount != null ? f.amount : unit * qty),
    postedAt: new Date().toISOString(),
    voided: false,
    voidReason: null
  };
}

function makePayment(f = {}) {
  if (!f.folioId) throw new Error('Payment: folioId required');
  if (!PAYMENT_METHOD[f.method]) throw new Error('Payment: invalid method ' + JSON.stringify(f.method));
  if (!(Number(f.amount) > 0)) throw new Error('Payment: amount must be > 0');
  return {
    paymentId: f.paymentId || crypto.randomUUID(),
    folioId: String(f.folioId),
    method: f.method,
    amount: round2(f.amount),
    reference: f.reference || null,
    allocatedAt: new Date().toISOString()
  };
}

module.exports = { FOLIO_STATUS, INVOICE_STATUS, ITEM_TYPE, PAYMENT_METHOD, round2, makeFolio, makeItem, makePayment };
