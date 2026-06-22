'use strict';

/**
 * Phase 8 - Finance Core ledger integration tests (spec section 10).
 *
 *   - invoice            -> balanced ledger batch (AR debit / Revenue credit)
 *   - payment allocation -> AR reduction (Cash debit / AR credit)
 *   - voucher redemption -> revenue adjustment (AgentCost debit / AR credit)
 *   - imbalance rejection
 *   - cost center / revenue mapping enforcement (hard fail, no fallback)
 *   - tenant + property isolation
 *
 * Everything is wired through the real command/query buses, the real
 * ledgerService and the in-memory fixture repos, mirroring how index.js wires
 * production.
 */

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');

const { makeCommands: makePmsCommands } = require('../src/commands/pms');
const { makeCheckinFolioCommands }      = require('../src/commands/pms/checkinFolio');
const { buildPaymentAllocationService } = require('../src/services/pms/paymentAllocation');
const { makePaymentAllocationCommands } = require('../src/commands/pms/paymentAllocation');
const { makeInvoiceCommands }           = require('../src/commands/pms/invoices');
const { makeVoucherCommands }           = require('../src/commands/pms/vouchers');
const { makeQueries: makePmsQueries }   = require('../src/queries/pms');

const { buildLedgerService }            = require('../src/services/finance/ledger');
const { makeCostCenterCommands }        = require('../src/commands/finance/costCenters');
const { makeRevenueMapCommands }        = require('../src/commands/finance/revenueMap');
const { makeLedgerCommands }            = require('../src/commands/finance/ledger');
const { makeQueries: makeFinanceQueries } = require('../src/queries/finance');

const { buildSettings, _resetCatalog }  = require('../src/services/settingsService');
const { bootstrapSettingsCatalog }      = require('../src/services/settingsCatalogBoot');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

function fresh() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  _resetCatalog(); bootstrapSettingsCatalog();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });

  const settingsService = buildSettings({ repo: repos.settingsRepo });
  const ledgerService = buildLedgerService({
    ledgerRepo: repos.ledgerRepo, revenueMapRepo: repos.revenueMapRepo,
    costCenterRepo: repos.costCenterRepo, eventBus
  });
  const paySvc = buildPaymentAllocationService({ folioRepo: repos.folioRepo, pmsRepo: repos.pmsRepo });

  makePmsCommands         ({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeCheckinFolioCommands({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo })
    .forEach((c) => commandBus.register(c));
  makePaymentAllocationCommands({ paymentAllocationService: paySvc, ledgerService }).forEach((c) => commandBus.register(c));
  makeInvoiceCommands     ({ folioRepo: repos.folioRepo, pmsRepo: repos.pmsRepo, settingsService, ledgerService }).forEach((c) => commandBus.register(c));
  makeVoucherCommands     ({ pmsRepo: repos.pmsRepo, settingsService, ledgerService }).forEach((c) => commandBus.register(c));
  makeCostCenterCommands  ({ costCenterRepo: repos.costCenterRepo }).forEach((c) => commandBus.register(c));
  makeRevenueMapCommands  ({ revenueMapRepo: repos.revenueMapRepo, costCenterRepo: repos.costCenterRepo }).forEach((c) => commandBus.register(c));
  makeLedgerCommands      ({ ledgerService }).forEach((c) => commandBus.register(c));

  makePmsQueries          ({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo }).forEach((q) => queryBus.register(q));
  makeFinanceQueries      ({ costCenterRepo: repos.costCenterRepo, revenueMapRepo: repos.revenueMapRepo, ledgerRepo: repos.ledgerRepo }).forEach((q) => queryBus.register(q));

  return { db, repos, ledgerService };
}

async function seedFinance(opts = {}) {
  const { invoiceMap = true, paymentMap = true, voucherMap = true, ccOnMaps = true } = opts;
  const cc = await commandBus.dispatch('finance.cost_center.create',
    { code: 'CC-ROOM', name: 'Room Revenue', type: 'ROOM' }, CTX());
  const ccId = cc.result.id;
  const pin = ccOnMaps ? ccId : null;
  if (invoiceMap) await commandBus.dispatch('finance.revenue_map.upsert',
    { event_type: 'invoice.issued', revenue_type: 'ROOM_REVENUE', debit_account: 'AR', credit_account: 'ROOM_REVENUE', cost_center_id: pin }, CTX());
  if (paymentMap) await commandBus.dispatch('finance.revenue_map.upsert',
    { event_type: 'folio.payment_allocated', revenue_type: 'PAYMENT_RECEIPT', debit_account: 'CASH', credit_account: 'AR', cost_center_id: ccId }, CTX());
  if (voucherMap) await commandBus.dispatch('finance.revenue_map.upsert',
    { event_type: 'voucher.redeemed', revenue_type: 'DISCOUNT_OR_AGENT_COST', debit_account: 'AGENT_COST', credit_account: 'AR', cost_center_id: ccId }, CTX());
  return { ccId };
}

async function settledFolio() {
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'A', last_name: 'A' }, CTX());
  const rt    = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, base_occupancy: 2, extra_bed_capacity: 0 }, CTX());
  const room  = await commandBus.dispatch('pms.room.create', { room_type_id: rt.result.id, room_number: '101' }, CTX());
  const res   = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adult.result.id, primary_adult_guest_id: adult.result.id,
    room_type_id: rt.result.id, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX());
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: res.result.id }, CTX());
  const ci = await commandBus.dispatch('pms.reservation.checkin',
    { reservation_id: res.result.id, assigned_room_id: room.result.id }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: ci.result.folio_id, charge_type: 'ROOM', amount: 100 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: ci.result.folio_id, charge_type: 'PAYMENT', amount: -100 }, CTX());
  return { folioId: ci.result.folio_id, reservationId: res.result.id };
}

function sum(entries, field) { return entries.reduce((s, e) => s + Number(e[field] || 0), 0); }

// --- 10.1 invoice -> ledger balance ----------------------------------------
test('invoice issue posts a balanced AR/Revenue ledger batch', async () => {
  const { db } = fresh();
  await seedFinance();
  const { folioId } = await settledFolio();
  const inv = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  assert.equal(inv.ok, true, JSON.stringify(inv));
  assert.ok(inv.result.ledger_batch_id, 'invoice should carry a ledger_batch_id');

  const led = await queryBus.execute('finance.ledger.by_reference',
    { reference_type: 'invoice', reference_id: inv.result.id }, CTX());
  assert.equal(led.ok, true);
  assert.equal(led.data.length, 2, 'expected a 2-leg double entry');
  assert.equal(sum(led.data, 'debit_amount'), 100);
  assert.equal(sum(led.data, 'credit_amount'), 100);
  assert.equal(sum(led.data, 'debit_amount'), sum(led.data, 'credit_amount'));
  const debitLeg  = led.data.find((e) => Number(e.debit_amount) > 0);
  const creditLeg = led.data.find((e) => Number(e.credit_amount) > 0);
  assert.equal(debitLeg.account_code, 'AR');
  assert.equal(creditLeg.account_code, 'ROOM_REVENUE');
  assert.equal(debitLeg.entry_type, 'INVOICE');

  // events emitted through the bus
  assert.ok(db.auditRows.find((x) => x.event_type === 'ledger.batch_posted'));
  assert.ok(db.auditRows.find((x) => x.event_type === 'ledger.entry_created'));
  assert.ok(db.auditRows.find((x) => x.event_type === 'revenue.mapped'));
});

// --- 10.2 payment allocation -> AR reduction --------------------------------
test('payment allocation posts Cash debit / AR credit', async () => {
  const { repos } = fresh();
  await seedFinance();
  // Build an open folio with a ROOM charge and a partial payment.
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'P' }, CTX());
  const rt    = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, base_occupancy: 2, extra_bed_capacity: 0 }, CTX());
  const room  = await commandBus.dispatch('pms.room.create', { room_type_id: rt.result.id, room_number: '201' }, CTX());
  const res   = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adult.result.id, primary_adult_guest_id: adult.result.id,
    room_type_id: rt.result.id, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX());
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: res.result.id }, CTX());
  const ci = await commandBus.dispatch('pms.reservation.checkin',
    { reservation_id: res.result.id, assigned_room_id: room.result.id }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: ci.result.folio_id, charge_type: 'ROOM', amount: 100 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: ci.result.folio_id, charge_type: 'PAYMENT', amount: -60 }, CTX());
  const payment = repos.folioRepo._store.lines.find((l) => l.charge_type === 'PAYMENT' && l.folio_id === ci.result.folio_id);

  const r = await commandBus.dispatch('pms.folio.payment.allocate',
    { folio_id: ci.result.folio_id, payment_line_id: payment.id }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.result.ledger_batch_id);

  const led = await queryBus.execute('finance.ledger.by_reference',
    { reference_type: 'payment_allocation', reference_id: payment.id }, CTX());
  assert.equal(led.data.length, 2);
  assert.equal(sum(led.data, 'debit_amount'), 60);
  assert.equal(sum(led.data, 'credit_amount'), 60);
  const creditLeg = led.data.find((e) => Number(e.credit_amount) > 0);
  assert.equal(creditLeg.account_code, 'AR', 'payment must credit (reduce) Accounts Receivable');
  assert.equal(led.data[0].entry_type, 'PAYMENT');
});

// --- 10.3 voucher redemption -> revenue adjustment --------------------------
test('voucher redemption posts agent-cost debit / AR credit', async () => {
  const { repos } = fresh();
  await seedFinance();
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'V' }, CTX());
  const rt    = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, base_occupancy: 2, extra_bed_capacity: 0 }, CTX());
  const res   = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adult.result.id, primary_adult_guest_id: adult.result.id,
    room_type_id: rt.result.id, arrival_date: '2026-07-01', departure_date: '2026-07-02'
  }, CTX());
  await commandBus.dispatch('pms.voucher.issue',
    { voucher_number: 'VCH-1', arrival_date: '2026-07-01', departure_date: '2026-07-02', amount: 75 }, CTX());
  const r = await commandBus.dispatch('pms.voucher.redeem',
    { voucher_number: 'VCH-1', reservation_id: res.result.id }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.result.ledger_batch_id);

  const led = await queryBus.execute('finance.ledger.by_reference',
    { reference_type: 'voucher', reference_id: r.result.id }, CTX());
  assert.equal(led.data.length, 2);
  assert.equal(sum(led.data, 'debit_amount'), 75);
  assert.equal(sum(led.data, 'credit_amount'), 75);
  const debitLeg = led.data.find((e) => Number(e.debit_amount) > 0);
  assert.equal(debitLeg.account_code, 'AGENT_COST');
  assert.equal(led.data[0].entry_type, 'VOUCHER');
});

// --- 10.4 imbalance rejection -----------------------------------------------
test('finance.ledger.post rejects an unbalanced batch and logs imbalance', async () => {
  const { db } = fresh();
  const r = await commandBus.dispatch('finance.ledger.post', {
    entry_type: 'ADJUSTMENT', reference_type: 'manual', reference_id: fx.PROP_ID,
    entries: [
      { account_code: 'CASH', debit_amount: 100, credit_amount: 0 },
      { account_code: 'AR',   debit_amount: 0,   credit_amount: 80 }   // 100 != 80
    ]
  }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ledger_imbalance');
  assert.ok(db.auditRows.find((x) => x.event_type === 'ledger.imbalance_rejected'),
    'imbalance must trigger an audit event');
});

test('finance.ledger.validate reports balance without mutating', async () => {
  fresh();
  const ok = await commandBus.dispatch('finance.ledger.validate', {
    entries: [{ debit_amount: 50 }, { credit_amount: 50 }]
  }, CTX());
  assert.equal(ok.result.balanced, true);
  assert.equal(ok.result.total_debit, 50);
  const bad = await commandBus.dispatch('finance.ledger.validate', {
    entries: [{ debit_amount: 50 }, { credit_amount: 40 }]
  }, CTX());
  assert.equal(bad.result.balanced, false);
});

// --- 10.5 mapping + cost-center enforcement (no fallback) --------------------
test('invoice issue HARD FAILS when no revenue mapping exists', async () => {
  fresh();
  await seedFinance({ invoiceMap: false });   // everything except invoice map
  const { folioId } = await settledFolio();
  const r = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'revenue_mapping_missing');
});

test('invoice issue requires a cost center when the map pins none', async () => {
  fresh();
  await seedFinance({ ccOnMaps: false });      // invoice map exists but with no cost center
  const { folioId } = await settledFolio();
  const r = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cost_center_required');
});

test('no orphan invoice is created when the ledger pre-flight rejects', async () => {
  const { repos } = fresh();
  await seedFinance({ invoiceMap: false });
  const { folioId } = await settledFolio();
  await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  assert.equal((repos.folioRepo._store.invoices || []).length, 0, 'invoice must not be persisted on reject');
});

test('revenue_map.upsert refuses a cost center from another property', async () => {
  fresh();
  const cc = await commandBus.dispatch('finance.cost_center.create',
    { code: 'CC-X', name: 'X', type: 'ROOM' }, CTX());
  const OTHER = '99999999-9999-1999-9999-999999999999';
  const r = await commandBus.dispatch('finance.revenue_map.upsert',
    { event_type: 'invoice.issued', revenue_type: 'ROOM_REVENUE', debit_account: 'AR',
      credit_account: 'ROOM_REVENUE', cost_center_id: cc.result.id }, CTX({ propertyId: OTHER }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cost_center_property_mismatch');
});

// --- 8.1/8.2 isolation -------------------------------------------------------
test('postEntryBatch rejects a cross-property entry', async () => {
  const { ledgerService } = fresh();
  const OTHER = '99999999-9999-1999-9999-999999999999';
  const out = await ledgerService.postEntryBatch({
    entryType: 'ADJUSTMENT', referenceType: 'manual', referenceId: fx.USER_ID,
    entries: [
      { account_code: 'CASH', debit_amount: 10, property_id: fx.PROP_ID },
      { account_code: 'AR',   credit_amount: 10, property_id: OTHER }
    ], ctx: CTX()
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'cross_property_entry');
});

test('ledger.by_reference does not leak across tenants', async () => {
  fresh();
  await seedFinance();
  const { folioId } = await settledFolio();
  const inv = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  const leak = await queryBus.execute('finance.ledger.by_reference',
    { reference_type: 'invoice', reference_id: inv.result.id }, CTX({ tenantId: fx.TENANT_B }));
  assert.equal(leak.data.length, 0, 'tenant B must not see tenant A ledger rows');
});

// --- idempotency -------------------------------------------------------------
test('finance.ledger.post is idempotent per reference + entry_type', async () => {
  fresh();
  const entries = [
    { account_code: 'CASH', debit_amount: 100 },
    { account_code: 'AR',   credit_amount: 100 }
  ];
  const args = { entry_type: 'ADJUSTMENT', reference_type: 'manual', reference_id: fx.USER_ID, entries };
  const a = await commandBus.dispatch('finance.ledger.post', args, CTX());
  const b = await commandBus.dispatch('finance.ledger.post', args, CTX());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.result.idempotent, true);
  assert.equal(a.result.batch_id, b.result.batch_id);
});

// --- revert ------------------------------------------------------------------
test('finance.ledger.revert posts an offsetting reversal batch', async () => {
  const { repos } = fresh();
  const posted = await commandBus.dispatch('finance.ledger.post', {
    entry_type: 'ADJUSTMENT', reference_type: 'manual', reference_id: fx.USER_ID,
    entries: [{ account_code: 'CASH', debit_amount: 100 }, { account_code: 'AR', credit_amount: 100 }]
  }, CTX());
  const rev = await commandBus.dispatch('finance.ledger.revert', { batch_id: posted.result.batch_id }, CTX());
  assert.equal(rev.ok, true, JSON.stringify(rev));
  const revEntries = await repos.ledgerRepo.listLedgerByBatch(rev.result.reversal_batch_id);
  assert.equal(revEntries.length, 2);
  // Debit and credit are swapped in the reversal.
  assert.equal(sum(revEntries, 'debit_amount'), 100);
  assert.equal(sum(revEntries, 'credit_amount'), 100);
});
