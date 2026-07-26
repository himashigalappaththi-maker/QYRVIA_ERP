'use strict';

/**
 * Phase 64 — THE gate test for P0-11.
 *
 * Runs the real PMS stay chain through the real command bus, the real
 * repositories and the real tenant-bound unit of work, against real PostgreSQL:
 *
 *   reservation.create -> confirm -> room allocation -> check-in ->
 *   folio charge -> cash payment -> night audit -> check-out ->
 *   housekeeping task -> audit/event verification
 *
 * Before Phase 64 this test could not exist. Every PMS repository method issued
 * a bare `pool.query`, and every table it touches is FORCE-RLS with a policy
 * keyed on `app.tenant_id`, so under a NOBYPASSRLS role every SELECT returned
 * zero rows and every INSERT failed its WITH CHECK.
 *
 * The connection role is asserted to be NON-superuser and NOBYPASSRLS at the
 * top, so a green run cannot be an artefact of an over-privileged role.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_dbHarness');

const URL = H.dbConfig();

if (!URL) {
  test('DB mode disabled (set TEST_DATABASE_URL to enable) - skipped', { skip: true }, () => {});
} else {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'db-mode-jwt-secret-at-least-32-characters-long';
  process.env.DATABASE_URL = process.env.DATABASE_URL || URL;

  const commandBus = require('../../src/core/commandBus');
  const queryBus   = require('../../src/core/queryBus');
  const eventBus   = require('../../src/core/eventBus');
  const { buildRepos }  = require('../../src/db/repos');
  const tenantUow       = require('../../src/db/tenantUnitOfWork');
  const { asTenantScoped } = require('../../src/commands/_tenantScoped');
  const { makeCommands: makePmsCommands }   = require('../../src/commands/pms');
  const { makeCheckinFolioCommands }        = require('../../src/commands/pms/checkinFolio');
  const { makeNightAuditCommands }          = require('../../src/commands/pms/nightAudit');
  const { buildNightAuditService }          = require('../../src/services/pms/nightAudit');

  let pool, repos, ctx, seed;

  const CTX = (o) => Object.assign({
    requestId: 'rq-life', tenantId: ctx.tenantId, propertyId: ctx.propertyId,
    businessDate: '2026-06-22', businessDateLocked: false,
    actorId: null, actorName: 'LifecycleTest',
    roleCodes: ['super_admin'], permissions: []
  }, o);

  const withUow = (fn) => tenantUow.runWithTenantTransaction(pool, ctx.tenantId, fn);

  before(async () => {
    const ddl = H.newPool(URL);
    try {
      await H.freshSchema(ddl);
      ctx = await H.seedTenantProperty(ddl, { code: 'LIFE', propCode: 'LIFEP' });
    } finally { await ddl.end(); }

    pool  = H.tenantBoundPool(URL, ctx.tenantId);
    repos = buildRepos(pool);

    eventBus.reset();
    eventBus.init({ db: H.realDbFacade(pool) });

    const nightAuditService = buildNightAuditService({
      nightAuditRepo: repos.nightAuditRepo, pmsRepo: repos.pmsRepo
    });

    commandBus.reset();
    queryBus.reset();
    const uow = {
      pool,
      runWithTenantTransaction: tenantUow.runWithTenantTransaction,
      runWithTenantRead:        tenantUow.runWithTenantRead
    };
    commandBus.setUnitOfWork(uow);
    queryBus.setUnitOfWork(uow);

    asTenantScoped(makePmsCommands({ pmsRepo: repos.pmsRepo })).forEach((c) => commandBus.register(c));
    asTenantScoped(makeCheckinFolioCommands({
      pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo
    })).forEach((c) => commandBus.register(c));
    asTenantScoped(makeNightAuditCommands({ nightAuditService })).forEach((c) => commandBus.register(c));

    // Property structure + guests. Seeded through the REAL repositories inside a
    // real unit of work — if the tenant binding were wrong, this would fail here.
    seed = await withUow(async () => {
      const prop = await repos.pmsRepo.findPropertyById(ctx.tenantId, ctx.propertyId);
      assert.ok(prop, 'the seeded property must be visible inside the tenant unit of work');

      const rt = await repos.pmsRepo.insertRoomType({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId, code: 'DLX', name: 'Deluxe',
        base_occupancy: 2, max_adults: 2, max_children: 2, extra_bed_capacity: 1 });
      const room = await repos.pmsRepo.insertRoom({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId, room_type_id: rt.id,
        room_number: '101', status: 'VACANT_CLEAN', active: true });
      const guest = await repos.pmsRepo.insertGuest({
        tenant_id: ctx.tenantId, property_id: ctx.propertyId,
        guest_type: 'INDIVIDUAL', first_name: 'Ada', last_name: 'Lovelace' });
      return { roomTypeId: rt.id, roomId: room.id, guestId: guest.id };
    });
  });

  after(async () => { if (pool) await pool.end(); });

  // -------------------------------------------------------------------------

  test('GUARD: the connection role is NON-superuser and NOBYPASSRLS', async () => {
    const r = await pool.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    assert.equal(r.rows[0].rolsuper, false,
      'a superuser would bypass RLS and make this whole test meaningless');
    assert.equal(r.rows[0].rolbypassrls, false, 'BYPASSRLS would do the same');
  });

  test('P0-11: the full stay chain runs end to end under FORCE RLS', async () => {
    // ---- 1. reservation.create -------------------------------------------
    const created = await commandBus.dispatch('pms.reservation.create', {
      holder_guest_id: seed.guestId, primary_adult_guest_id: seed.guestId,
      room_type_id: seed.roomTypeId, arrival_date: '2026-06-22', departure_date: '2026-06-24',
      adults: 2, children: 0
    }, CTX());
    assert.equal(created.ok, true, 'reservation.create: ' + JSON.stringify(created));
    const reservationId = created.result.id;

    let row = await withUow(() => repos.pmsRepo.findReservationById(ctx.tenantId, reservationId));
    assert.ok(row, 'the reservation must be visible inside the tenant context');
    assert.equal(row.tenant_id, ctx.tenantId);
    assert.equal(row.property_id, ctx.propertyId);
    assert.equal(row.status, 'INQUIRY');

    // ---- 2. confirm -------------------------------------------------------
    const confirmed = await commandBus.dispatch('pms.reservation.confirm',
      { reservation_id: reservationId }, CTX());
    assert.equal(confirmed.ok, true, 'confirm: ' + JSON.stringify(confirmed));
    row = await withUow(() => repos.pmsRepo.findReservationById(ctx.tenantId, reservationId));
    assert.equal(row.status, 'CONFIRMED');

    // ---- 3 + 4. room allocation + check-in --------------------------------
    const checkedIn = await commandBus.dispatch('pms.reservation.checkin',
      { reservation_id: reservationId, assigned_room_id: seed.roomId }, CTX());
    assert.equal(checkedIn.ok, true, 'checkin: ' + JSON.stringify(checkedIn));

    const afterCheckin = await withUow(async () => ({
      res:  await repos.pmsRepo.findReservationById(ctx.tenantId, reservationId),
      room: await repos.pmsRepo.findRoomById(ctx.tenantId, seed.roomId),
      folios: await repos.folioRepo.listFoliosForReservation(ctx.tenantId, reservationId)
    }));
    assert.equal(afterCheckin.res.status, 'CHECKED_IN');
    assert.equal(afterCheckin.room.status, 'OCCUPIED');
    assert.equal(afterCheckin.folios.length, 1, 'check-in opens exactly one folio');
    assert.equal(afterCheckin.folios[0].status, 'OPEN');
    assert.equal(afterCheckin.folios[0].property_id, ctx.propertyId);
    const folioId = afterCheckin.folios[0].id;

    // ---- 5. folio charge --------------------------------------------------
    const charge = await commandBus.dispatch('pms.folio.charge.post', {
      folio_id: folioId, charge_type: 'ROOM', amount: 200, description: 'Room 101 x2'
    }, CTX());
    assert.equal(charge.ok, true, 'charge: ' + JSON.stringify(charge));

    let folio = await withUow(() => repos.folioRepo.findFolioById(ctx.tenantId, folioId));
    assert.equal(Number(folio.total_charges), 200, 'the balance rollup ran in the same transaction');
    assert.equal(Number(folio.balance), 200);

    // ---- 6. cash payment --------------------------------------------------
    const paid = await commandBus.dispatch('pms.folio.payment.cash', {
      folio_id: folioId, amount: 200, tendered: 200
    }, CTX());
    assert.equal(paid.ok, true, 'cash: ' + JSON.stringify(paid));

    folio = await withUow(() => repos.folioRepo.findFolioById(ctx.tenantId, folioId));
    assert.equal(Number(folio.balance), 0, 'folio settles to zero');
    assert.equal(Number(folio.total_payments), -200);

    // ---- 7. night audit ---------------------------------------------------
    const audit = await commandBus.dispatch('pms.night_audit.run',
      { business_date: '2026-06-22' }, CTX());
    assert.equal(audit.ok, true, 'night audit: ' + JSON.stringify(audit));

    const prop = await withUow(() => repos.pmsRepo.findPropertyById(ctx.tenantId, ctx.propertyId));
    assert.equal(prop.business_date_locked, false,
      'the audit must release the lock — a stuck lock freezes the property forever');

    // ---- 8 + 9. check-out + room status + housekeeping --------------------
    const out = await commandBus.dispatch('pms.reservation.checkout',
      { reservation_id: reservationId }, CTX());
    assert.equal(out.ok, true, 'checkout: ' + JSON.stringify(out));

    const afterOut = await withUow(async () => ({
      res:   await repos.pmsRepo.findReservationById(ctx.tenantId, reservationId),
      room:  await repos.pmsRepo.findRoomById(ctx.tenantId, seed.roomId),
      folio: await repos.folioRepo.findFolioById(ctx.tenantId, folioId),
      tasks: await repos.housekeepingRepo.listTasks(ctx.tenantId, ctx.propertyId, {})
    }));
    assert.equal(afterOut.res.status, 'CHECKED_OUT');
    assert.equal(afterOut.room.status, 'VACANT_DIRTY');
    assert.equal(afterOut.folio.status, 'CLOSED');
    assert.ok(afterOut.tasks.some((t) => t.room_id === seed.roomId),
      'check-out must leave a housekeeping task for the vacated room');

    // ---- 10. audit / event record ----------------------------------------
    const events = await pool.query(
      `SELECT event_type, event_version FROM event_store
        WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY event_version`,
      [ctx.tenantId, reservationId]);
    const types = events.rows.map((r) => r.event_type);
    for (const expected of ['reservation.created', 'reservation.confirmed',
                            'reservation.checked_in', 'reservation.checked_out']) {
      assert.ok(types.includes(expected), 'missing domain event: ' + expected + ' (got ' + types.join(', ') + ')');
    }
    // Phase 63 P0-1 regression: the whole stream persists, monotonically.
    const versions = events.rows.map((r) => r.event_version);
    assert.deepEqual(versions, versions.slice().sort((a, b) => a - b));
    assert.equal(new Set(versions).size, versions.length, 'event_version must be unique per aggregate');

    const audits = await pool.query(
      `SELECT count(*)::int n FROM audit_events WHERE tenant_id = $1 AND event_type LIKE 'command.%'`,
      [ctx.tenantId]);
    assert.ok(audits.rows[0].n > 0, 'the audit pipeline must have persisted command rows');
  });

  test('P0-11: rows written by the chain are INVISIBLE to another tenant', async () => {
    // A second tenant, bound to its own context, must see none of it.
    const ddl = H.newPool(URL);
    let otherTenantId;
    try {
      const other = await H.seedTenantProperty(ddl, { code: 'OTHR', propCode: 'OTHRP' });
      otherTenantId = other.tenantId;
    } finally { await ddl.end(); }

    const otherPool = H.tenantBoundPool(URL, otherTenantId);
    try {
      const res = await otherPool.query('SELECT count(*)::int n FROM reservations');
      assert.equal(res.rows[0].n, 0, 'cross-tenant reservation leak');
      const fol = await otherPool.query('SELECT count(*)::int n FROM folios');
      assert.equal(fol.rows[0].n, 0, 'cross-tenant folio leak');
      const hk = await otherPool.query('SELECT count(*)::int n FROM housekeeping_tasks');
      assert.equal(hk.rows[0].n, 0, 'cross-tenant housekeeping leak');
    } finally { await otherPool.end(); }
  });

  test('P0-11: a tenant-scoped repository call OUTSIDE a unit of work throws (no pool fallback)', async () => {
    await assert.rejects(
      () => repos.pmsRepo.findReservationById(ctx.tenantId, seed.roomId),
      (e) => e.code === 'TENANT_CONTEXT_REQUIRED',
      'the whole point of Phase 64: an unbound tenant query must fail loudly, not silently return nothing'
    );
  });
}
