'use strict';

/** Phase 14 - Billing Engine (folio / charges / tax / payments / invoice). */

// Env sentinels before requiring app modules (eventBus -> logger -> env in the subscriber test).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryBillingRepo } = require('../src/billing/repository/billingRepo.memory');
const { buildBillingEngine } = require('../src/billing/core/BillingEngine');
const { buildBillingSubscriber } = require('../src/billing/services/billingSubscriber');

const CTX = (propertyId) => ({ tenantId: 't1', propertyId, requestId: 'rq' });

function fresh() {
  const events = [];
  const eventBus = { publish: async (e) => { events.push(e); }, subscribe: () => () => {} };
  const billing = buildBillingEngine({ repo: buildMemoryBillingRepo(), eventBus });
  return { events, billing };
}
const types = (events) => events.map((e) => e.event_type);

test('folio creation from a stay is idempotent (1 stay = 1 folio)', async () => {
  const { billing } = fresh();
  const f1 = await billing.createFolio(CTX('PA'), { stayId: 'S1', reservationId: 'R1', roomId: 'RM1' });
  const f2 = await billing.createFolio(CTX('PA'), { stayId: 'S1' });
  assert.equal(f1.folioId, f2.folioId);
  assert.equal(f1.status, 'OPEN');
});

test('room charge posts net + service charge + VAT per tax config', async () => {
  const { billing, events } = fresh();
  billing.setTaxConfig(CTX('PA'), { vatPct: 10, serviceChargePct: 5, inclusive: false });
  const f = await billing.createFolio(CTX('PA'), { stayId: 'S1' });
  await billing.postRoomCharge(CTX('PA'), { folioId: f.folioId, quantity: 2, unitRate: 100 }); // base 200

  const { totals, items } = await billing.getStatement(CTX('PA'), f.folioId);
  assert.equal(totals.chargesTotal, 231);                 // 200 + 10 sc + 21 vat
  assert.deepEqual(items.map((i) => i.type).sort(), ['ROOM', 'SERVICE_CHARGE', 'TAX']);
  assert.ok(types(events).includes('folio.posted'));
});

test('void charge removes it from the balance', async () => {
  const { billing } = fresh();
  const f = await billing.createFolio(CTX('PA'), { stayId: 'S1' });
  const extra = (await billing.postExtra(CTX('PA'), { folioId: f.folioId, description: 'Minibar', amount: 50, taxable: false })).lines[0];
  assert.equal((await billing.getBalance(CTX('PA'), f.folioId)).chargesTotal, 50);
  await billing.voidCharge(CTX('PA'), { folioId: f.folioId, itemId: extra.itemId, reason: 'guest dispute' });
  assert.equal((await billing.getBalance(CTX('PA'), f.folioId)).chargesTotal, 0);
});

test('split payments allowed; finalize requires an exactly balanced folio', async () => {
  const { billing, events } = fresh();
  const f = await billing.createFolio(CTX('PA'), { stayId: 'S1' });
  await billing.postExtra(CTX('PA'), { folioId: f.folioId, description: 'Dinner', amount: 150, taxable: false }); // total 150

  // not yet balanced -> finalize rejected
  await billing.recordPayment(CTX('PA'), { folioId: f.folioId, method: 'CASH', amount: 100 });
  await assert.rejects(() => billing.finalizeInvoice(CTX('PA'), { folioId: f.folioId }), /invoice_not_balanced/);

  // balance it with a split card payment -> finalize succeeds
  await billing.recordPayment(CTX('PA'), { folioId: f.folioId, method: 'CARD', amount: 50 });
  const inv = await billing.finalizeInvoice(CTX('PA'), { folioId: f.folioId });
  assert.equal(inv.status, 'FINAL');
  assert.equal(inv.balance, 0);
  assert.ok(types(events).includes('payment.received'));
  assert.ok(types(events).includes('invoice.finalized'));
});

test('overpayment cannot finalize (strict exact match)', async () => {
  const { billing } = fresh();
  const f = await billing.createFolio(CTX('PA'), { stayId: 'S1' });
  await billing.postExtra(CTX('PA'), { folioId: f.folioId, description: 'X', amount: 100, taxable: false });
  await billing.recordPayment(CTX('PA'), { folioId: f.folioId, method: 'CASH', amount: 120 });
  await assert.rejects(() => billing.finalizeInvoice(CTX('PA'), { folioId: f.folioId }), /invoice_not_balanced/);
});

test('finalized invoice is immutable (folio locked, no re-finalize)', async () => {
  const { billing } = fresh();
  const f = await billing.createFolio(CTX('PA'), { stayId: 'S1' });
  await billing.postExtra(CTX('PA'), { folioId: f.folioId, description: 'X', amount: 80, taxable: false });
  await billing.recordPayment(CTX('PA'), { folioId: f.folioId, method: 'CASH', amount: 80 });
  await billing.finalizeInvoice(CTX('PA'), { folioId: f.folioId });

  await assert.rejects(() => billing.postExtra(CTX('PA'), { folioId: f.folioId, description: 'late', amount: 10, taxable: false }), /folio_closed/);
  await assert.rejects(() => billing.finalizeInvoice(CTX('PA'), { folioId: f.folioId }), /invoice_already_final/);
});

test('proforma invoice is a non-locked snapshot', async () => {
  const { billing } = fresh();
  const f = await billing.createFolio(CTX('PA'), { stayId: 'S1' });
  await billing.postExtra(CTX('PA'), { folioId: f.folioId, description: 'X', amount: 60, taxable: false });
  const pf = await billing.generateProforma(CTX('PA'), { folioId: f.folioId });
  assert.equal(pf.status, 'PROFORMA');
  assert.equal(pf.locked, false);
  assert.equal(pf.total, 60);
});

test('multi-property isolation', async () => {
  const { billing } = fresh();
  const f = await billing.createFolio(CTX('PA'), { stayId: 'S1' });
  assert.equal(await billing.getFolio(CTX('PB'), f.folioId), null);
  await assert.rejects(() => billing.postRoomCharge(CTX('PB'), { folioId: f.folioId, quantity: 1, unitRate: 50 }), /folio_not_found/);
});

test('subscriber opens a folio on stay.started and proforma on stay.ended (no engine coupling)', async () => {
  const eventBus = require('../src/core/eventBus');
  eventBus.reset();
  eventBus.init({ db: { auditRows: [], async insertAuditEvent(ev) { this.auditRows.push(ev); } } });
  const billing = buildBillingEngine({ repo: buildMemoryBillingRepo(), eventBus });
  buildBillingSubscriber({ eventBus, billing });

  const base = { tenant_id: 't1', property_id: 'PA' };
  await eventBus.publish(Object.assign({ event_type: 'stay.started', event_id: 'e1', payload: { stay_id: 'S9', reservation_id: 'R9', room_id: 'RM9' } }, base));
  const folio = await billing.getFolioByStay(CTX('PA'), 'S9');
  assert.ok(folio, 'folio opened from stay.started');

  await billing.postExtra(CTX('PA'), { folioId: folio.folioId, description: 'X', amount: 40, taxable: false });
  await eventBus.publish(Object.assign({ event_type: 'stay.ended', event_id: 'e2', payload: { stay_id: 'S9' } }, base));
  const inv = await billing.getInvoice(CTX('PA'), folio.folioId);
  assert.ok(inv, 'proforma generated on stay.ended');
  assert.equal(inv.status, 'PROFORMA');
});
