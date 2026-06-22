'use strict';

/**
 * Phase 9.1 - Financial flows against REAL PostgreSQL (DB mode).
 *
 * Exercises the production code paths (real `buildRepos(pool)`, real
 * `ledgerService`, real eventBus → real audit/event tables) instead of the
 * in-memory fakes. Covers: invoice → ledger bridge, cost-center tagging,
 * audit logging, payment-allocation balance rule, imbalance rejection, and
 * idempotency — all verified by reading rows back out of the database.
 *
 * Runs as the DB owner (RLS bypassed), mirroring how the production app pool
 * connects today. RLS itself is proven separately in rls.db.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  // Unit-test sentinels must be present before requiring app modules.
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'db-mode-jwt-secret-at-least-32-characters-long';
  process.env.DATABASE_URL = process.env.DATABASE_URL || URL;

  const commandBus = require('../../src/core/commandBus');
  const eventBus   = require('../../src/core/eventBus');
  const { buildRepos } = require('../../src/db/repos');
  const { buildLedgerService } = require('../../src/services/finance/ledger');
  const { buildPaymentAllocationService } = require('../../src/services/pms/paymentAllocation');
  const { makeInvoiceCommands } = require('../../src/commands/pms/invoices');
  const { makePaymentAllocationCommands } = require('../../src/commands/pms/paymentAllocation');
  const { makeLedgerCommands } = require('../../src/commands/finance/ledger');

  let admin, repos, ledgerService, ctx;

  const CTX = (o) => Object.assign({
    requestId: 'rq-db', tenantId: ctx.tenantId, propertyId: ctx.propertyId,
    businessDate: '2026-06-22', businessDateLocked: false,
    actorId: null, actorName: 'DBTest', roleCodes: ['super_admin'], permissions: []
  }, o);

  before(async () => {
    admin = H.newPool(URL);
    await H.freshSchema(admin);
    const seeded = await H.seedTenantProperty(admin, { code: 'FIN', propCode: 'FINP' });
    ctx = seeded;

    repos = buildRepos(admin);
    eventBus.reset();
    eventBus.init({ db: H.realDbFacade(admin) });
    ledgerService = buildLedgerService({
      ledgerRepo: repos.ledgerRepo, revenueMapRepo: repos.revenueMapRepo,
      costCenterRepo: repos.costCenterRepo, eventBus
    });
    const paySvc = buildPaymentAllocationService({ folioRepo: repos.folioRepo, pmsRepo: repos.pmsRepo });

    commandBus.reset();
    makeInvoiceCommands({ folioRepo: repos.folioRepo, pmsRepo: repos.pmsRepo, ledgerService }).forEach((c) => commandBus.register(c));
    makePaymentAllocationCommands({ paymentAllocationService: paySvc, ledgerService }).forEach((c) => commandBus.register(c));
    makeLedgerCommands({ ledgerService }).forEach((c) => commandBus.register(c));

    // Seed a cost center + the three revenue maps (pin the cost center on each).
    const cc = await repos.costCenterRepo.insertCostCenter({
      tenant_id: ctx.tenantId, property_id: ctx.propertyId, code: 'CC-ROOM', name: 'Room', type: 'ROOM' });
    ctx.costCenterId = cc.id;
    for (const [ev, dr, crd] of [
      ['invoice.issued', 'AR', 'ROOM_REVENUE'],
      ['folio.payment_allocated', 'CASH', 'AR'],
      ['voucher.redeemed', 'AGENT_COST', 'AR']]) {
      await repos.revenueMapRepo.upsertRevenueMap({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId, event_type: ev,
        revenue_type: ev, cost_center_id: cc.id, debit_account: dr, credit_account: crd });
    }
  });
  after(async () => { if (admin) await admin.end(); });

  async function settledFolio(amount = 100, paid = amount) {
    const f = await repos.folioRepo.insertFolio({
      tenant_id: ctx.tenantId, property_id: ctx.propertyId,
      folio_number: 'F-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
      status: 'OPEN', currency: 'LKR', business_date: '2026-06-22' });
    await repos.folioRepo.insertFolioLine({
      tenant_id: ctx.tenantId, folio_id: f.id, charge_type: 'ROOM', amount, business_date: '2026-06-22' });
    if (paid) await repos.folioRepo.insertFolioLine({
      tenant_id: ctx.tenantId, folio_id: f.id, charge_type: 'PAYMENT', amount: -paid, business_date: '2026-06-22' });
    return repos.folioRepo.findFolioById(ctx.tenantId, f.id);
  }

  const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);

  test('invoice issue posts a balanced AR/Revenue batch to the real ledger', async () => {
    const folio = await settledFolio(100);
    assert.equal(Number(folio.balance), 0, 'folio settled in DB');
    const inv = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folio.id }, CTX());
    assert.equal(inv.ok, true, JSON.stringify(inv));
    assert.ok(inv.result.ledger_batch_id);

    const entries = await repos.ledgerRepo.findLedgerByReference(ctx.tenantId, 'invoice', inv.result.id);
    assert.equal(entries.length, 2);
    assert.equal(sum(entries, 'debit_amount'), 100);
    assert.equal(sum(entries, 'credit_amount'), 100);
    // cost-center tagging persisted
    assert.ok(entries.every((e) => e.cost_center_id === ctx.costCenterId));
    // batch row balanced in DB
    const batch = await admin.query('SELECT total_debit, total_credit FROM ledger_batches WHERE id=$1',
      [inv.result.ledger_batch_id]);
    assert.equal(Number(batch.rows[0].total_debit), Number(batch.rows[0].total_credit));

    // audit logging persisted to real tables
    const ev = await admin.query(
      `SELECT event_type FROM audit_events WHERE tenant_id=$1 AND event_type = ANY($2)`,
      [ctx.tenantId, ['invoice.issued', 'ledger.batch_posted', 'revenue.mapped', 'ledger.entry_created']]);
    const types = new Set(ev.rows.map((r) => r.event_type));
    for (const t of ['invoice.issued', 'ledger.batch_posted', 'revenue.mapped']) {
      assert.ok(types.has(t), 'missing audit event: ' + t);
    }
    // domain events dual-persisted to event_store
    const es = await admin.query(`SELECT count(*)::int n FROM event_store WHERE event_type='ledger.batch_posted'`);
    assert.ok(es.rows[0].n >= 1);
  });

  test('imbalanced manual post is rejected and writes NO ledger rows', async () => {
    const ref = (await admin.query('SELECT gen_random_uuid() id')).rows[0].id;
    const r = await commandBus.dispatch('finance.ledger.post', {
      entry_type: 'ADJUSTMENT', reference_type: 'manual', reference_id: ref,
      entries: [{ account_code: 'CASH', debit_amount: 100 }, { account_code: 'AR', credit_amount: 70 }]
    }, CTX());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ledger_imbalance');
    const n = await admin.query('SELECT count(*)::int n FROM ledger_entries WHERE reference_id=$1', [ref]);
    assert.equal(n.rows[0].n, 0, 'no rows persisted on imbalance');
    const ie = await admin.query(`SELECT count(*)::int n FROM audit_events WHERE event_type='ledger.imbalance_rejected' AND aggregate_id=$1`, [ref]);
    assert.equal(ie.rows[0].n, 1);
  });

  test('manual ledger post is idempotent per reference (exactly one batch in DB)', async () => {
    const ref = (await admin.query('SELECT gen_random_uuid() id')).rows[0].id;
    const args = { entry_type: 'ADJUSTMENT', reference_type: 'manual', reference_id: ref,
      entries: [{ account_code: 'CASH', debit_amount: 50 }, { account_code: 'AR', credit_amount: 50 }] };
    const a = await commandBus.dispatch('finance.ledger.post', args, CTX());
    const b = await commandBus.dispatch('finance.ledger.post', args, CTX());
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(b.result.idempotent, true);
    const n = await admin.query('SELECT count(*)::int n FROM ledger_entries WHERE reference_id=$1', [ref]);
    assert.equal(n.rows[0].n, 2, 'second post did not duplicate rows');
  });

  test('payment allocation posts a balanced Cash/AR batch and credits AR', async () => {
    const f = await repos.folioRepo.insertFolio({
      tenant_id: ctx.tenantId, property_id: ctx.propertyId,
      folio_number: 'PA-' + Date.now(), status: 'OPEN', currency: 'LKR', business_date: '2026-06-22' });
    await repos.folioRepo.insertFolioLine({ tenant_id: ctx.tenantId, folio_id: f.id, charge_type: 'ROOM', amount: 100, business_date: '2026-06-22' });
    const payLine = await repos.folioRepo.insertFolioLine({ tenant_id: ctx.tenantId, folio_id: f.id, charge_type: 'PAYMENT', amount: -60, business_date: '2026-06-22' });

    const r = await commandBus.dispatch('pms.folio.payment.allocate',
      { folio_id: f.id, payment_line_id: payLine.id }, CTX());
    assert.equal(r.ok, true, JSON.stringify(r));
    const entries = await repos.ledgerRepo.findLedgerByReference(ctx.tenantId, 'payment_allocation', payLine.id);
    assert.equal(entries.length, 2);
    assert.equal(sum(entries, 'debit_amount'), 60);
    assert.equal(sum(entries, 'credit_amount'), 60);
    assert.equal(entries.find((e) => Number(e.credit_amount) > 0).account_code, 'AR');
  });

  test('payment allocation balance rule: explicit over-allocation is rejected', async () => {
    const f = await repos.folioRepo.insertFolio({
      tenant_id: ctx.tenantId, property_id: ctx.propertyId,
      folio_number: 'OV-' + Date.now(), status: 'OPEN', currency: 'LKR', business_date: '2026-06-22' });
    const charge = await repos.folioRepo.insertFolioLine({ tenant_id: ctx.tenantId, folio_id: f.id, charge_type: 'ROOM', amount: 40, business_date: '2026-06-22' });
    const payLine = await repos.folioRepo.insertFolioLine({ tenant_id: ctx.tenantId, folio_id: f.id, charge_type: 'PAYMENT', amount: -100, business_date: '2026-06-22' });
    const r = await commandBus.dispatch('pms.folio.payment.allocate', {
      folio_id: f.id, payment_line_id: payLine.id,
      allocations: [{ charge_line_id: charge.id, amount: 80 }]   // > 40 owed
    }, CTX());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'allocation_exceeds_charge');
  });

  test('cost-center report aggregates real ledger rows by cost center', async () => {
    const rep = await repos.ledgerRepo.reportByCostCenter(ctx.tenantId, ctx.propertyId, {});
    const row = rep.find((x) => x.cost_center_id === ctx.costCenterId);
    assert.ok(row, 'cost center should appear in report');
    assert.ok(row.debit > 0 && row.credit > 0);
  });
}
