'use strict';

/**
 * Phase 64 — P1-5 / P1-6 / P1-8 rollback proof, against real PostgreSQL.
 *
 * Before Phase 64 each statement in these flows was its own autocommit on an
 * arbitrary pooled connection, so a mid-chain failure left the reservation
 * CHECKED_IN with no folio, or a folio line posted with a stale balance, or
 * allocation rows committed with no ledger batch — and the status guard at the
 * top of each handler made the retry impossible.
 *
 * Each test injects a failure at a specific step and asserts that NOTHING from
 * that command survives. The failures are injected by making a repository
 * method throw, so the failure happens in the middle of the real transaction.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'db-mode-jwt-secret-at-least-32-characters-long';
  process.env.DATABASE_URL = process.env.DATABASE_URL || URL;

  const commandBus = require('../../src/core/commandBus');
  const eventBus   = require('../../src/core/eventBus');
  const { buildRepos }  = require('../../src/db/repos');
  const tenantUow       = require('../../src/db/tenantUnitOfWork');
  const { asTenantScoped } = require('../../src/commands/_tenantScoped');
  const { makeCommands: makePmsCommands } = require('../../src/commands/pms');
  const { makeCheckinFolioCommands }      = require('../../src/commands/pms/checkinFolio');
  const { makePaymentAllocationCommands } = require('../../src/commands/pms/paymentAllocation');
  const { buildPaymentAllocationService } = require('../../src/services/pms/paymentAllocation');
  const { buildLedgerService }            = require('../../src/services/finance/ledger');

  let pool, repos, ctx, seed;
  // Failure switches, flipped per test. The wrappers below consult them.
  const fail = { insertFolio: false, insertTask: false, folioRollup: false, ledgerPost: false };

  const CTX = (o) => Object.assign({
    requestId: 'rq-rb', tenantId: ctx.tenantId, propertyId: ctx.propertyId,
    businessDate: '2026-06-22', businessDateLocked: false,
    actorId: null, actorName: 'RollbackTest',
    roleCodes: ['super_admin'], permissions: []
  }, o);

  const withUow = (fn) => tenantUow.runWithTenantTransaction(pool, ctx.tenantId, fn);

  function injected(name) {
    const e = new Error('injected failure: ' + name);
    e.injected = true;
    return e;
  }

  before(async () => {
    const ddl = H.newPool(URL);
    try {
      await H.freshSchema(ddl);
      ctx = await H.seedTenantProperty(ddl, { code: 'RBK', propCode: 'RBKP' });
    } finally { await ddl.end(); }

    pool  = H.tenantBoundPool(URL, ctx.tenantId);
    repos = buildRepos(pool);

    eventBus.reset();
    eventBus.init({ db: H.realDbFacade(pool) });

    // ---- failure-injecting wrappers around the REAL repositories ----------
    const realInsertFolio     = repos.folioRepo.insertFolio.bind(repos.folioRepo);
    const realInsertFolioLine = repos.folioRepo.insertFolioLine.bind(repos.folioRepo);
    const realInsertTask      = repos.housekeepingRepo.insertTask.bind(repos.housekeepingRepo);

    repos.folioRepo.insertFolio = async (rec) => {
      if (fail.insertFolio) throw injected('folioRepo.insertFolio');
      return realInsertFolio(rec);
    };
    repos.housekeepingRepo.insertTask = async (rec) => {
      if (fail.insertTask) throw injected('housekeepingRepo.insertTask');
      return realInsertTask(rec);
    };
    // The rollup is the SECOND statement inside insertFolioLine. Let the INSERT
    // land, then fail — that is exactly the P1-6 shape.
    repos.folioRepo.insertFolioLine = async (rec) => {
      const line = await realInsertFolioLine(rec);
      if (fail.folioRollup) throw injected('folio balance rollup');
      return line;
    };

    const ledgerService = buildLedgerService({
      ledgerRepo: repos.ledgerRepo, revenueMapRepo: repos.revenueMapRepo,
      costCenterRepo: repos.costCenterRepo, eventBus
    });
    const realPostForEvent = ledgerService.postForEvent.bind(ledgerService);
    ledgerService.postForEvent = async (args) => {
      if (fail.ledgerPost) throw injected('ledgerService.postForEvent');
      return realPostForEvent(args);
    };

    const paySvc = buildPaymentAllocationService({
      folioRepo: repos.folioRepo, pmsRepo: repos.pmsRepo });

    commandBus.reset();
    commandBus.setUnitOfWork({
      pool,
      runWithTenantTransaction: tenantUow.runWithTenantTransaction,
      runWithTenantRead:        tenantUow.runWithTenantRead
    });
    asTenantScoped(makePmsCommands({ pmsRepo: repos.pmsRepo })).forEach((c) => commandBus.register(c));
    asTenantScoped(makeCheckinFolioCommands({
      pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo
    })).forEach((c) => commandBus.register(c));
    asTenantScoped(makePaymentAllocationCommands({
      paymentAllocationService: paySvc, ledgerService, folioRepo: repos.folioRepo
    })).forEach((c) => commandBus.register(c));

    seed = await withUow(async () => {
      const rt = await repos.pmsRepo.insertRoomType({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId, code: 'STD', name: 'Standard',
        base_occupancy: 2, max_adults: 2, max_children: 1, extra_bed_capacity: 0 });
      const guest = await repos.pmsRepo.insertGuest({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId,
        guest_type: 'INDIVIDUAL', first_name: 'Grace', last_name: 'Hopper' });
      // Cost center + revenue map so the ledger path is otherwise viable.
      const cc = await repos.costCenterRepo.insertCostCenter({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId, code: 'CC-RB', name: 'RB', type: 'ROOM' });
      await repos.revenueMapRepo.upsertRevenueMap({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId,
        event_type: 'folio.payment_allocated', revenue_type: 'folio.payment_allocated',
        cost_center_id: cc.id, debit_account: 'CASH', credit_account: 'AR' });
      return { roomTypeId: rt.id, guestId: guest.id, costCenterId: cc.id };
    });
  });

  after(async () => { if (pool) await pool.end(); });
  beforeEach(() => {
    fail.insertFolio = false; fail.insertTask = false;
    fail.folioRollup = false; fail.ledgerPost = false;
  });

  /** A fresh room + a CONFIRMED reservation for that room. */
  async function freshConfirmedStay(tag) {
    const room = await withUow(() => repos.pmsRepo.insertRoom({
      tenant_id: ctx.tenantId, property_id: ctx.propertyId, room_type_id: seed.roomTypeId,
      room_number: tag, status: 'VACANT_CLEAN', active: true }));

    const created = await commandBus.dispatch('pms.reservation.create', {
      holder_guest_id: seed.guestId, primary_adult_guest_id: seed.guestId,
      room_type_id: seed.roomTypeId, arrival_date: '2026-06-22', departure_date: '2026-06-23',
      adults: 1, children: 0
    }, CTX());
    assert.equal(created.ok, true, JSON.stringify(created));
    const confirmed = await commandBus.dispatch('pms.reservation.confirm',
      { reservation_id: created.result.id }, CTX());
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    return { reservationId: created.result.id, roomId: room.id };
  }

  // -------------------------------------------------------------------------
  // 1. CHECK-IN: folio creation fails
  // -------------------------------------------------------------------------

  test('P1-5: check-in folio creation fails -> reservation NOT checked in, room NOT occupied, NO folio', async () => {
    const { reservationId, roomId } = await freshConfirmedStay('R-CI');

    fail.insertFolio = true;
    const r = await commandBus.dispatch('pms.reservation.checkin',
      { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
    assert.equal(r.ok, false, 'the command must fail');
    assert.equal(r.error, 'handler_threw');

    const after = await withUow(async () => ({
      res:    await repos.pmsRepo.findReservationById(ctx.tenantId, reservationId),
      room:   await repos.pmsRepo.findRoomById(ctx.tenantId, roomId),
      folios: await repos.folioRepo.listFoliosForReservation(ctx.tenantId, reservationId)
    }));
    assert.equal(after.res.status, 'CONFIRMED', 'reservation status must be untouched');
    assert.equal(after.room.status, 'VACANT_CLEAN', 'room status must be untouched');
    assert.equal(after.folios.length, 0, 'no folio may remain');

    // No event may have been published for a rolled-back command.
    const ev = await pool.query(
      `SELECT count(*)::int n FROM event_store
        WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='reservation.checked_in'`,
      [ctx.tenantId, reservationId]);
    assert.equal(ev.rows[0].n, 0, 'a rolled-back check-in must publish nothing');

    // And the retry now WORKS — the old code left the reservation CHECKED_IN,
    // so the retry was rejected as invalid_transition and the stay was stuck.
    fail.insertFolio = false;
    const retry = await commandBus.dispatch('pms.reservation.checkin',
      { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
    assert.equal(retry.ok, true, 'the command must be retryable after a clean rollback: ' + JSON.stringify(retry));
  });

  // -------------------------------------------------------------------------
  // 2. CHECK-OUT: housekeeping task creation fails
  // -------------------------------------------------------------------------

  test('P1-5: check-out housekeeping fails -> reservation NOT checked out, folio NOT closed, room NOT dirty', async () => {
    const { reservationId, roomId } = await freshConfirmedStay('R-CO');
    const ci = await commandBus.dispatch('pms.reservation.checkin',
      { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
    assert.equal(ci.ok, true, JSON.stringify(ci));

    fail.insertTask = true;
    const r = await commandBus.dispatch('pms.reservation.checkout',
      { reservation_id: reservationId }, CTX());
    assert.equal(r.ok, false);

    const after = await withUow(async () => ({
      res:    await repos.pmsRepo.findReservationById(ctx.tenantId, reservationId),
      room:   await repos.pmsRepo.findRoomById(ctx.tenantId, roomId),
      folios: await repos.folioRepo.listFoliosForReservation(ctx.tenantId, reservationId)
    }));
    assert.equal(after.res.status, 'CHECKED_IN', 'reservation must still be in house');
    assert.equal(after.room.status, 'OCCUPIED', 'room must still be occupied');
    assert.equal(after.folios[0].status, 'OPEN', 'folio must NOT be closed');

    fail.insertTask = false;
    const retry = await commandBus.dispatch('pms.reservation.checkout',
      { reservation_id: reservationId }, CTX());
    assert.equal(retry.ok, true, 'check-out must be retryable: ' + JSON.stringify(retry));
  });

  // -------------------------------------------------------------------------
  // 3. FOLIO LINE: balance rollup fails
  // -------------------------------------------------------------------------

  test('P1-6: folio balance rollup fails -> NO folio line remains', async () => {
    const { reservationId, roomId } = await freshConfirmedStay('R-FL');
    await commandBus.dispatch('pms.reservation.checkin',
      { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
    const folios = await withUow(() =>
      repos.folioRepo.listFoliosForReservation(ctx.tenantId, reservationId));
    const folioId = folios[0].id;

    fail.folioRollup = true;
    const r = await commandBus.dispatch('pms.folio.charge.post',
      { folio_id: folioId, charge_type: 'ROOM', amount: 500 }, CTX());
    assert.equal(r.ok, false);

    const after = await withUow(async () => ({
      lines: await repos.folioRepo.listFolioLines(ctx.tenantId, folioId),
      folio: await repos.folioRepo.findFolioById(ctx.tenantId, folioId)
    }));
    assert.equal(after.lines.length, 0,
      'the INSERT landed before the rollup failed — the transaction must take it back');
    assert.equal(Number(after.folio.balance), 0, 'the balance must be untouched');

    fail.folioRollup = false;
    const retry = await commandBus.dispatch('pms.folio.charge.post',
      { folio_id: folioId, charge_type: 'ROOM', amount: 500 }, CTX());
    assert.equal(retry.ok, true, JSON.stringify(retry));
    const settled = await withUow(async () => ({
      lines: await repos.folioRepo.listFolioLines(ctx.tenantId, folioId),
      folio: await repos.folioRepo.findFolioById(ctx.tenantId, folioId)
    }));
    assert.equal(settled.lines.length, 1, 'exactly one line — the rolled-back one must not reappear');
    assert.equal(Number(settled.folio.balance), 500);
  });

  // -------------------------------------------------------------------------
  // 4. PAYMENT ALLOCATION: ledger post fails
  // -------------------------------------------------------------------------

  test('P1-8: ledger post fails -> NO allocation row remains and no partial payment state', async () => {
    const { reservationId, roomId } = await freshConfirmedStay('R-PA');
    await commandBus.dispatch('pms.reservation.checkin',
      { reservation_id: reservationId, assigned_room_id: roomId }, CTX());
    const folios = await withUow(() =>
      repos.folioRepo.listFoliosForReservation(ctx.tenantId, reservationId));
    const folioId = folios[0].id;

    await commandBus.dispatch('pms.folio.charge.post',
      { folio_id: folioId, charge_type: 'ROOM', amount: 300 }, CTX());
    const payLine = await withUow(() => repos.folioRepo.insertFolioLine({
      tenant_id: ctx.tenantId, folio_id: folioId, charge_type: 'PAYMENT',
      amount: -300, business_date: '2026-06-22' }));

    fail.ledgerPost = true;
    const r = await commandBus.dispatch('pms.folio.payment.allocate',
      { folio_id: folioId, payment_line_id: payLine.id, cost_center_id: seed.costCenterId }, CTX());
    assert.equal(r.ok, false, 'the command must fail');

    const rows = await pool.query(
      `SELECT count(*)::int n FROM payment_allocations WHERE tenant_id=$1 AND payment_line_id=$2`,
      [ctx.tenantId, payLine.id]);
    assert.equal(rows.rows[0].n, 0,
      'allocation rows were committed before the ledger post — the transaction must take them back');

    const batches = await pool.query(
      `SELECT count(*)::int n FROM ledger_batches WHERE tenant_id=$1`, [ctx.tenantId]);
    assert.equal(batches.rows[0].n, 0, 'no ledger batch may remain');

    // The poisoned-retry hazard: with the allocations rolled back, a retry
    // re-allocates AND posts the ledger, instead of reporting success with no
    // ledger entry at all.
    fail.ledgerPost = false;
    const retry = await commandBus.dispatch('pms.folio.payment.allocate',
      { folio_id: folioId, payment_line_id: payLine.id, cost_center_id: seed.costCenterId }, CTX());
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.ok(retry.result.ledger_batch_id,
      'the retry must actually post the ledger — reporting success with a null batch is how cash goes missing');

    const after = await pool.query(
      `SELECT count(*)::int n FROM payment_allocations WHERE tenant_id=$1 AND payment_line_id=$2`,
      [ctx.tenantId, payLine.id]);
    assert.equal(after.rows[0].n, 1, 'exactly one allocation after the successful retry');
  });
}
