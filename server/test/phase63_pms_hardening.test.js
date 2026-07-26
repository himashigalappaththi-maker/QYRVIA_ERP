'use strict';

/**
 * Phase 63 P0-6 / P0-7 / P0-10 — PMS operational-reliability regressions.
 *
 * P0-6   PENDING_PAYMENT holds must consume inventory.
 * P0-7   OUT_OF_ORDER / OUT_OF_SERVICE / BLOCKED rooms must not be sellable.
 * P0-10  A night audit that cannot even start must release the business-date
 *        lock it just took, or the property is frozen forever.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const availability = require('../src/services/pms/availability');
const { buildNightAuditService } = require('../src/services/pms/nightAudit');

// ---------------------------------------------------------------------------
// P0-6 — held inventory
// ---------------------------------------------------------------------------

test('P0-6: PENDING_PAYMENT is a hold status (an unheld payment window is an overbooking window)', () => {
  assert.ok(availability.HOLD_STATUSES.includes('PENDING_PAYMENT'));
  assert.ok(availability.HOLD_STATUSES.includes('CONFIRMED'));
  assert.ok(availability.HOLD_STATUSES.includes('OPTION'));
});

test('P0-6: a PENDING_PAYMENT reservation reduces availability', async () => {
  const repo = {
    async listRoomsForAvailability() {
      return [
        { id: 'r1', room_number: '101', status: 'VACANT_CLEAN', active: true, room_type_id: 'rt1', room_type_code: 'DLX' },
        { id: 'r2', room_number: '102', status: 'VACANT_CLEAN', active: true, room_type_id: 'rt1', room_type_code: 'DLX' }
      ];
    },
    async listReservationsOverlapping({ statuses }) {
      // The repo receives the hold-status list; only a status in that list counts.
      return statuses.includes('PENDING_PAYMENT')
        ? [{ room_type_id: 'rt1', rooms_count: 1, status: 'PENDING_PAYMENT' }]
        : [];
    }
  };

  const byType = await availability.roomsByDate(repo, {
    tenantId: 't1', propertyId: 'p1', date: '2026-08-01'
  });

  assert.equal(byType.rt1.total, 2);
  assert.equal(byType.rt1.occupied, 1, 'the payment hold must be counted as consumed');
  assert.equal(byType.rt1.available, 1);
});

// ---------------------------------------------------------------------------
// P0-7 — non-sellable rooms
// ---------------------------------------------------------------------------

test('P0-7: the non-sellable set is exactly OUT_OF_ORDER / OUT_OF_SERVICE / BLOCKED', () => {
  assert.deepEqual([...availability.NON_SELLABLE_ROOM_STATUSES].sort(),
    ['BLOCKED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE']);
  assert.equal(availability.isSellableRoom({ active: true, status: 'VACANT_CLEAN' }), true);
  assert.equal(availability.isSellableRoom({ active: true, status: 'OCCUPIED' }), true);
  assert.equal(availability.isSellableRoom({ active: true, status: 'OUT_OF_ORDER' }), false);
  assert.equal(availability.isSellableRoom({ active: true, status: 'BLOCKED' }), false);
  assert.equal(availability.isSellableRoom({ active: false, status: 'VACANT_CLEAN' }), false);
});

test('P0-7: out-of-order and blocked rooms are excluded from sellable total but still listed', async () => {
  const repo = {
    async listRoomsForAvailability() {
      return [
        { id: 'r1', room_number: '101', status: 'VACANT_CLEAN',   active: true, room_type_id: 'rt1', room_type_code: 'DLX' },
        { id: 'r2', room_number: '102', status: 'OUT_OF_ORDER',   active: true, room_type_id: 'rt1', room_type_code: 'DLX' },
        { id: 'r3', room_number: '103', status: 'BLOCKED',        active: true, room_type_id: 'rt1', room_type_code: 'DLX' },
        { id: 'r4', room_number: '104', status: 'OUT_OF_SERVICE', active: true, room_type_id: 'rt1', room_type_code: 'DLX' }
      ];
    },
    async listReservationsOverlapping() { return []; }
  };

  const byType = await availability.roomsByDate(repo, {
    tenantId: 't1', propertyId: 'p1', date: '2026-08-01'
  });

  assert.equal(byType.rt1.total, 1, 'only the one sellable room counts');
  assert.equal(byType.rt1.out_of_service, 3);
  assert.equal(byType.rt1.available, 1);
  assert.equal(byType.rt1.rooms.length, 4, 'the front desk still sees every room');
});

test('P0-7: the range calendar also excludes non-sellable rooms', async () => {
  const repo = {
    async listRoomsForAvailability() {
      return [
        { id: 'r1', room_number: '101', status: 'VACANT_CLEAN', active: true, room_type_id: 'rt1', room_type_code: 'DLX' },
        { id: 'r2', room_number: '102', status: 'OUT_OF_ORDER', active: true, room_type_id: 'rt1', room_type_code: 'DLX' }
      ];
    },
    async listReservationsInRange() { return []; }
  };

  const out = await availability.inventoryByRange(repo, {
    tenantId: 't1', propertyId: 'p1', dateFrom: '2026-08-01', dateTo: '2026-08-03'
  });

  assert.equal(out.days.length, 2);
  for (const d of out.days) {
    assert.equal(d.roomTypes.DLX.total, 1, 'a calendar must not advertise an out-of-order room');
    assert.equal(d.roomTypes.DLX.available, 1);
  }
});

// ---------------------------------------------------------------------------
// P0-10 — night audit must not strand the property
// ---------------------------------------------------------------------------

function nightAuditRepoStub({ insertRunThrows = false } = {}) {
  const state = { locked: null, lockCalls: [], failed: [], runs: [] };
  return {
    state,
    async setPropertyBusinessDateLocked(tenantId, propertyId, locked) {
      state.locked = locked; state.lockCalls.push(locked);
    },
    async insertRun(rec) {
      if (insertRunThrows) {
        const e = new Error('duplicate key value violates unique constraint "ux_night_audit_property_busdate"');
        e.code = '23505';
        throw e;
      }
      const run = Object.assign({ id: 'run-1' }, rec);
      state.runs.push(run);
      return run;
    },
    // Mirrors production: the UPDATE that advances the date also sets
    // business_date_locked = false (src/db/repos.js advancePropertyBusinessDate).
    async advancePropertyBusinessDate() { state.locked = false; },
    async completeRun(t, id, stats) { return { id, status: 'COMPLETED', stats }; },
    async failRun(t, id, err) { state.failed.push({ id, err: String(err && err.message) }); }
  };
}

test('P0-10: a duplicate night-audit run releases the lock instead of freezing the property', async () => {
  const repo = nightAuditRepoStub({ insertRunThrows: true });
  const na = buildNightAuditService({ nightAuditRepo: repo, pmsRepo: {} });

  const r = await na.runForProperty({
    tenantId: 't1', propertyId: 'p1', businessDate: '2026-08-01', triggeredBy: 'u1'
  });

  assert.equal(r.ok, false);
  assert.equal(r.error, 'night_audit_start_failed');
  assert.deepEqual(repo.state.lockCalls, [true, false],
    'the lock must be taken and then released');
  assert.equal(repo.state.locked, false,
    'a stuck lock rejects every accounting-sensitive command for this property forever');
});

test('P0-10: a step failure still unlocks (existing behaviour preserved)', async () => {
  const repo = nightAuditRepoStub();
  const na = buildNightAuditService({ nightAuditRepo: repo, pmsRepo: {} });
  na.registerStep('boom', async () => { throw new Error('step exploded'); });

  const r = await na.runForProperty({
    tenantId: 't1', propertyId: 'p1', businessDate: '2026-08-01', triggeredBy: 'u1'
  });

  assert.equal(r.ok, false);
  assert.equal(r.error, 'night_audit_failed');
  assert.equal(repo.state.locked, false);
  assert.equal(repo.state.failed.length, 1);
});

test('P0-10: a successful run unlocks and completes', async () => {
  const repo = nightAuditRepoStub();
  const na = buildNightAuditService({ nightAuditRepo: repo, pmsRepo: {} });

  const r = await na.runForProperty({
    tenantId: 't1', propertyId: 'p1', businessDate: '2026-08-01', triggeredBy: 'u1'
  });

  assert.equal(r.ok, true);
  assert.equal(repo.state.locked, false);
});
