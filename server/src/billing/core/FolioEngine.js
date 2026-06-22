'use strict';

/**
 * FolioEngine - the ledger container for a stay. Owns folio creation, charge
 * posting / voiding, and balance + statement. Emits `folio.posted` on each
 * posting. A folio CLOSED by invoice finalization is immutable (charges/voids
 * rejected).
 */

const crypto = require('crypto');
const { makeFolio, makeItem, FOLIO_STATUS, ITEM_TYPE, round2 } = require('../models/FolioModel');

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

function buildFolioEngine({ repo, eventBus } = {}) {
  if (!repo) throw new Error('FolioEngine: repo required');

  function requireProperty(ctx) { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; }

  async function emit(type, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType: 'folio', aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt financial state */ }
  }

  async function getFolioOrThrow(propertyId, folioId) {
    const f = await repo.getFolio(propertyId, folioId);
    if (!f) throw new Error('folio_not_found');
    return f;
  }

  return {
    async createFolio(ctx, { stayId, reservationId, roomId, currency } = {}) {
      const propertyId = requireProperty(ctx);
      if (!stayId) throw new Error('stayId required');
      const existing = await repo.getFolioByStay(propertyId, stayId);   // 1 stay = 1 folio (idempotent)
      if (existing) return existing;
      const folio = makeFolio({ propertyId, stayId, reservationId, roomId, currency });
      const saved = await repo.insertFolio(folio);
      await emit('folio.created', saved.folioId, { folio_id: saved.folioId, stay_id: stayId, property_id: propertyId }, ctx);
      return saved;
    },

    async getFolio(ctx, folioId) { return repo.getFolio(requireProperty(ctx), folioId); },
    async getFolioByStay(ctx, stayId) { return repo.getFolioByStay(requireProperty(ctx), stayId); },

    async addCharge(ctx, { folioId, type, description, amount, quantity, unitAmount } = {}) {
      const propertyId = requireProperty(ctx);
      const folio = await getFolioOrThrow(propertyId, folioId);
      if (folio.status !== FOLIO_STATUS.OPEN) throw new Error('folio_closed');
      if (!ITEM_TYPE[type]) throw new Error('invalid_charge_type');
      const item = makeItem({ folioId, type, description, amount, quantity, unitAmount });
      const saved = await repo.insertItem(item);
      await emit('folio.posted', folioId, { folio_id: folioId, item_id: saved.itemId, type, amount: saved.amount, property_id: propertyId }, ctx);
      return saved;
    },

    async voidCharge(ctx, { folioId, itemId, reason } = {}) {
      const propertyId = requireProperty(ctx);
      const folio = await getFolioOrThrow(propertyId, folioId);
      if (folio.status !== FOLIO_STATUS.OPEN) throw new Error('folio_closed');
      const items = await repo.listItems(folioId);
      const it = items.find((i) => i.itemId === itemId);
      if (!it) throw new Error('item_not_found');
      if (it.voided) return it;
      return repo.updateItem(itemId, { voided: true, voidReason: reason || null });
    },

    async getBalance(ctx, folioId) {
      const propertyId = requireProperty(ctx);
      await getFolioOrThrow(propertyId, folioId);
      const items = await repo.listItems(folioId);
      const payments = await repo.listPayments(folioId);
      const chargesTotal = round2(items.filter((i) => !i.voided).reduce((s, i) => s + Number(i.amount), 0));
      const paymentsTotal = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
      return { chargesTotal, paymentsTotal, balance: round2(chargesTotal - paymentsTotal) };
    },

    async getStatement(ctx, folioId) {
      const propertyId = requireProperty(ctx);
      const folio = await getFolioOrThrow(propertyId, folioId);
      const items = await repo.listItems(folioId);
      const payments = await repo.listPayments(folioId);
      const balance = await this.getBalance(ctx, folioId);
      return { folio, items, payments, totals: balance };
    },

    async closeFolio(ctx, folioId) {
      const propertyId = requireProperty(ctx);
      await getFolioOrThrow(propertyId, folioId);
      return repo.updateFolio(propertyId, folioId, { status: FOLIO_STATUS.CLOSED, closedAt: new Date().toISOString() });
    },

    _newId: () => crypto.randomUUID()
  };
}

module.exports = { buildFolioEngine };
