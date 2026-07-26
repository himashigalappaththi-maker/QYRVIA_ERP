'use strict';

/**
 * Phase 64 P1-7 — cross-property isolation on the LIVE PMS write chain.
 *
 * RLS blocks cross-TENANT rows only; cross-PROPERTY access within a tenant is
 * application-level, and this chain was not enforcing it. A user scoped to
 * property A could check in, check out, post charges to, and close a folio
 * belonging to property B of the same tenant — and check-in then stamped the
 * new folio with property A.
 *
 * NOTE: the only pre-existing "cannot check in another property's reservation"
 * assertion in the repository lives in server/test/pms_frontdesk.test.js, which
 * tests the UNMOUNTED engine under src/pms/** — dead code. This file tests the
 * live commands under src/commands/pms/**.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');
const { makeCheckinFolioCommands }      = require('../src/commands/pms/checkinFolio');
const { makePaymentAllocationCommands } = require('../src/commands/pms/paymentAllocation');

const TENANT = 't-1';
const PROP_A = 'prop-A';
const PROP_B = 'prop-B';

/** Minimal in-memory repos holding ONE reservation/room/folio, all in property B. */
function buildWorld() {
  const state = {
    reservation: { id: 'res-B', tenant_id: TENANT, property_id: PROP_B, status: 'CONFIRMED',
                   assigned_room_id: 'room-B', reservation_number: 'B-1' },
    room:  { id: 'room-B', tenant_id: TENANT, property_id: PROP_B, status: 'VACANT_CLEAN', room_number: '201' },
    folio: { id: 'folio-B', tenant_id: TENANT, property_id: PROP_B, status: 'OPEN',
             balance: 0, total_charges: 0, total_payments: 0, folio_number: 'B-F-1',
             business_date: '2026-06-22', reservation_id: 'res-B' },
    writes: []
  };

  const pmsRepo = {
    async findReservationById(t, id) { return (state.reservation.id === id) ? { ...state.reservation } : null; },
    async findRoomById(t, id)        { return (state.room.id === id) ? { ...state.room } : null; },
    async findPropertyById(t, id)    { return { id, code: 'P', currency: 'LKR' }; },
    async checkInReservation(t, id)  { state.writes.push('checkInReservation'); state.reservation.status = 'CHECKED_IN'; return { ...state.reservation }; },
    async checkOutReservation(t, id) { state.writes.push('checkOutReservation'); state.reservation.status = 'CHECKED_OUT'; return { ...state.reservation }; }
  };
  const folioRepo = {
    async findFolioById(t, id) { return (state.folio.id === id) ? { ...state.folio } : null; },
    async listFoliosForReservation() { return [{ ...state.folio }]; },
    async bumpFolioCounter() { state.writes.push('bumpFolioCounter'); return { next_number: 1 }; },
    async insertFolio(rec) { state.writes.push('insertFolio'); return { ...rec, id: 'new-folio' }; },
    async insertFolioLine(rec) { state.writes.push('insertFolioLine'); return { ...rec, id: 'line-1' }; },
    async closeFolio() { state.writes.push('closeFolio'); state.folio.status = 'CLOSED'; return { ...state.folio }; },
    async listFolioLines() { return []; }
  };
  const housekeepingRepo = {
    async insertTask(rec) { state.writes.push('insertTask'); return { ...rec, id: 'task-1' }; }
  };
  return { state, pmsRepo, folioRepo, housekeepingRepo };
}

let world;

const CTX = (propertyId) => ({
  tenantId: TENANT, propertyId, requestId: 'rq-1', actorId: 'u-1',
  businessDate: '2026-06-22', businessDateLocked: false,
  roleCodes: ['super_admin'], permissions: []
});

beforeEach(() => {
  commandBus.reset();
  eventBus.reset();
  eventBus.init({ db: { async insertAuditEvent() {}, async insertDomainEvent() {} } });
  world = buildWorld();
  const paymentAllocationService = { async allocate() { return { ok: true, allocations: [], unallocated_remainder: 0 }; } };
  makeCheckinFolioCommands({
    pmsRepo: world.pmsRepo, folioRepo: world.folioRepo, housekeepingRepo: world.housekeepingRepo
  }).forEach((c) => commandBus.register(c));
  makePaymentAllocationCommands({
    paymentAllocationService, ledgerService: null, folioRepo: world.folioRepo
  }).forEach((c) => commandBus.register(c));
});
afterEach(() => { commandBus.reset(); eventBus.reset(); });

// ---------------------------------------------------------------------------
// Every operational write must reject a property-A context on a property-B row
// ---------------------------------------------------------------------------

const CROSS_PROPERTY_CASES = [
  ['pms.reservation.checkin',       { reservation_id: 'res-B', assigned_room_id: 'room-B' }],
  ['pms.reservation.checkout',      { reservation_id: 'res-B' }],
  ['pms.folio.charge.post',         { folio_id: 'folio-B', charge_type: 'ROOM', amount: 100 }],
  ['pms.folio.payment.cash',        { folio_id: 'folio-B', amount: 50, tendered: 50 }],
  ['pms.folio.close',               { folio_id: 'folio-B' }],
  ['pms.folio.payment.allocate',    { folio_id: 'folio-B', payment_line_id: 'line-1' }]
];

for (const [name, input] of CROSS_PROPERTY_CASES) {
  test('P1-7: ' + name + ' rejects a property-A context on a property-B row', async () => {
    const r = await commandBus.dispatch(name, input, CTX(PROP_A));
    assert.equal(r.ok, false, name + ' must be rejected');
    assert.equal(r.error, 'property_access_denied', name + ' -> ' + JSON.stringify(r));
    assert.deepEqual(world.state.writes, [], name + ': no write may occur before the rejection');
    // And the target rows are untouched.
    assert.equal(world.state.reservation.status, 'CONFIRMED');
    assert.equal(world.state.room.status, 'VACANT_CLEAN');
    assert.equal(world.state.folio.status, 'OPEN');
  });
}

for (const [name, input] of CROSS_PROPERTY_CASES) {
  test('P1-7: ' + name + ' requires a property context at all', async () => {
    const ctx = CTX(PROP_A); delete ctx.propertyId;
    const r = await commandBus.dispatch(name, input, ctx);
    assert.equal(r.ok, false);
    assert.ok(['property_required', 'property_context_required'].includes(r.error),
      name + ' -> ' + JSON.stringify(r));
    assert.deepEqual(world.state.writes, []);
  });
}

test('P1-7: the SAME property context is allowed through (the guard is not a blanket deny)', async () => {
  const r = await commandBus.dispatch('pms.reservation.checkin',
    { reservation_id: 'res-B', assigned_room_id: 'room-B' }, CTX(PROP_B));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(world.state.writes.includes('checkInReservation'));
  assert.ok(world.state.writes.includes('insertFolio'));
});

test('P1-7: there is NO corporate/super_admin bypass — the role does not grant cross-property write', async () => {
  const ctx = Object.assign(CTX(PROP_A), { roleCodes: ['super_admin', 'corporate_admin'] });
  const r = await commandBus.dispatch('pms.folio.charge.post',
    { folio_id: 'folio-B', charge_type: 'ROOM', amount: 100 }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'property_access_denied',
    'a corporate user must switch INTO the property context, not bypass it');
});

test('P1-7 (hazard H3): a room inherited from the reservation is still property-checked', async () => {
  // No assigned_room_id in the input: the room comes from before.assigned_room_id.
  // The old code skipped the ownership guard entirely on this path, yet still
  // flipped that room to OCCUPIED.
  const r = await commandBus.dispatch('pms.reservation.checkin',
    { reservation_id: 'res-B' }, CTX(PROP_A));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'property_access_denied');
  assert.equal(world.state.room.status, 'VACANT_CLEAN', 'the room must not be touched');
});
