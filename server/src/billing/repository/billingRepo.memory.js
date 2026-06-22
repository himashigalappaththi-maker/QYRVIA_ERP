'use strict';

/**
 * In-memory billing repository (default backing). Property-scoped at the folio
 * level; items / payments / invoices are keyed by folioId and only reachable
 * after resolving their property-scoped folio (enforced in the engines).
 *
 * A pg-backed repo (additive billing tables) can replace this without touching
 * the engines.
 */

function buildMemoryBillingRepo() {
  const folios = new Map();        // propertyId|folioId -> folio
  const items = [];                // FolioItem[]
  const payments = [];             // Payment[]
  const invoices = new Map();      // folioId -> invoice
  const byStay = new Map();        // propertyId|stayId -> folioId
  const k = (p, id) => p + '|' + id;

  return {
    async insertFolio(folio) {
      folios.set(k(folio.propertyId, folio.folioId), Object.assign({}, folio));
      byStay.set(k(folio.propertyId, folio.stayId), folio.folioId);
      return Object.assign({}, folio);
    },
    async getFolio(propertyId, folioId) {
      const f = folios.get(k(propertyId, folioId));
      return f ? Object.assign({}, f) : null;
    },
    async getFolioByStay(propertyId, stayId) {
      const id = byStay.get(k(propertyId, stayId));
      return id ? this.getFolio(propertyId, id) : null;
    },
    async updateFolio(propertyId, folioId, patch) {
      const key = k(propertyId, folioId);
      const f = folios.get(key);
      if (!f) return null;
      Object.assign(f, patch, { updatedAt: new Date().toISOString() });
      return Object.assign({}, f);
    },

    async insertItem(item) { items.push(Object.assign({}, item)); return Object.assign({}, item); },
    async listItems(folioId) { return items.filter((i) => i.folioId === folioId).map((i) => Object.assign({}, i)); },
    async updateItem(itemId, patch) {
      const it = items.find((i) => i.itemId === itemId);
      if (!it) return null;
      Object.assign(it, patch);
      return Object.assign({}, it);
    },

    async insertPayment(p) { payments.push(Object.assign({}, p)); return Object.assign({}, p); },
    async listPayments(folioId) { return payments.filter((p) => p.folioId === folioId).map((p) => Object.assign({}, p)); },

    async upsertInvoice(inv) { invoices.set(inv.folioId, Object.assign({}, inv)); return Object.assign({}, inv); },
    async getInvoiceByFolio(folioId) { const v = invoices.get(folioId); return v ? Object.assign({}, v) : null; }
  };
}

module.exports = { buildMemoryBillingRepo };
