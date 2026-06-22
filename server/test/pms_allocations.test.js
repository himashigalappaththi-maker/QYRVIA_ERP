'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands: makePmsCommands } = require('../src/commands/pms');
const { buildAllocationService } = require('../src/services/pms/allocation');
const { makeAllocationCommands } = require('../src/commands/pms/allocations');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

async function fresh() {
  commandBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  const svc = buildAllocationService({ pmsRepo: repos.pmsRepo, eventBus });
  makePmsCommands       ({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeAllocationCommands({ pmsRepo: repos.pmsRepo, allocationService: svc }).forEach((c) => commandBus.register(c));

  // Wire the same subscribers production wires in src/index.js.
  eventBus.subscribe('reservation.created', async (event) => {
    const allocId = event.payload && event.payload.allocation_id;
    if (!allocId) return;
    await svc.consume({ tenantId: event.tenant_id, allocationId: allocId, qty: 1,
      ctx: { tenantId: event.tenant_id, propertyId: event.property_id, requestId: 'sub-' + event.event_id } });
  });
  eventBus.subscribe('reservation.cancelled', async (event) => {
    const allocId = event.payload && event.payload.allocation_id;
    if (!allocId) return;
    await svc.decrement({ tenantId: event.tenant_id, allocationId: allocId, qty: 1,
      ctx: { tenantId: event.tenant_id, propertyId: event.property_id, requestId: 'sub-' + event.event_id } });
  });

  // Seed a guest + room type
  const agent = await commandBus.dispatch('pms.guest.create',
    { first_name: 'Acme Travel', guest_type: 'TRAVEL_AGENT' }, CTX());
  const rt    = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, base_occupancy: 2, extra_bed_capacity: 0 }, CTX());
  return { db, repos, svc, agentId: agent.result.id, roomTypeId: rt.result.id };
}

test('C7: pms.allocation.create persists ACTIVE row with qty_blocked', async () => {
  const { db, roomTypeId, agentId } = await fresh();
  const r = await commandBus.dispatch('pms.allocation.create', {
    partner_guest_id: agentId, room_type_id: roomTypeId,
    date_from: '2026-08-01', date_to: '2026-08-10',
    qty_blocked: 5, release_days: 7
  }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.qty_blocked, 5);
  const ev = db.auditRows.find(x => x.event_type === 'allocation.created');
  assert.equal(ev.payload.qty_blocked, 5);
});

test('C7: reservation.created against an allocation auto-consumes qty', async () => {
  const { repos, agentId, roomTypeId } = await fresh();
  const alloc = await commandBus.dispatch('pms.allocation.create',
    { partner_guest_id: agentId, room_type_id: roomTypeId,
      date_from: '2026-08-01', date_to: '2026-08-10', qty_blocked: 3, release_days: 7 }, CTX());
  // Make a guest holder
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'A' }, CTX());
  await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adult.result.id, primary_adult_guest_id: adult.result.id,
    room_type_id: roomTypeId, arrival_date: '2026-08-02', departure_date: '2026-08-04',
    allocation_id: alloc.result.id
  }, CTX());
  // Allow subscriber microtask to flush
  await new Promise((r) => setImmediate(r));
  const stored = repos.pmsRepo._allocations.find((a) => a.id === alloc.result.id);
  assert.equal(stored.qty_consumed, 1);
  assert.equal(stored.status, 'ACTIVE');
});

test('C7: reservation.cancelled releases the allocated qty back', async () => {
  const { repos, agentId, roomTypeId } = await fresh();
  const alloc = await commandBus.dispatch('pms.allocation.create',
    { partner_guest_id: agentId, room_type_id: roomTypeId,
      date_from: '2026-08-01', date_to: '2026-08-10', qty_blocked: 3, release_days: 7 }, CTX());
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'A' }, CTX());
  const res   = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adult.result.id, primary_adult_guest_id: adult.result.id,
    room_type_id: roomTypeId, arrival_date: '2026-08-02', departure_date: '2026-08-04',
    allocation_id: alloc.result.id
  }, CTX());
  await new Promise((r) => setImmediate(r));
  await commandBus.dispatch('pms.reservation.cancel', { reservation_id: res.result.id, reason: 'change_of_plans' }, CTX());
  await new Promise((r) => setImmediate(r));
  const stored = repos.pmsRepo._allocations.find((a) => a.id === alloc.result.id);
  assert.equal(stored.qty_consumed, 0);
});

test('C7: consuming past qty_blocked exhausts the allocation', async () => {
  const { repos, svc, agentId, roomTypeId } = await fresh();
  const alloc = await commandBus.dispatch('pms.allocation.create',
    { partner_guest_id: agentId, room_type_id: roomTypeId,
      date_from: '2026-08-01', date_to: '2026-08-10', qty_blocked: 1, release_days: 7 }, CTX());
  const out1 = await svc.consume({ tenantId: fx.TENANT_A, allocationId: alloc.result.id, qty: 1, ctx: CTX() });
  assert.equal(out1.ok, true);
  assert.equal(out1.exhausted, true);
  const out2 = await svc.consume({ tenantId: fx.TENANT_A, allocationId: alloc.result.id, qty: 1, ctx: CTX() });
  assert.equal(out2.ok, false);
  assert.equal(out2.error, 'allocation_exhausted_or_inactive');
});

test('C7: pms.allocation.release flips ACTIVE -> RELEASED + emits event', async () => {
  const { db, agentId, roomTypeId } = await fresh();
  const alloc = await commandBus.dispatch('pms.allocation.create',
    { partner_guest_id: agentId, room_type_id: roomTypeId,
      date_from: '2026-08-01', date_to: '2026-08-10', qty_blocked: 3, release_days: 7 }, CTX());
  const r = await commandBus.dispatch('pms.allocation.release',
    { allocation_id: alloc.result.id, reason: 'manual' }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.status, 'RELEASED');
  const ev = db.auditRows.find(x => x.event_type === 'allocation.released');
  assert.equal(ev.payload.reason, 'manual');
});

test('C7: sweepReleases flips allocations whose release window has passed', async () => {
  const { svc, repos, agentId, roomTypeId } = await fresh();
  // alloc1: date_from in 2 days, release_days=7 -> should be due (release_window already passed)
  const a1 = await commandBus.dispatch('pms.allocation.create',
    { partner_guest_id: agentId, room_type_id: roomTypeId,
      date_from: '2026-06-24', date_to: '2026-06-30', qty_blocked: 5, release_days: 7 }, CTX());
  // alloc2: date_from in 60 days, release_days=7 -> still in window
  const a2 = await commandBus.dispatch('pms.allocation.create',
    { partner_guest_id: agentId, room_type_id: roomTypeId,
      date_from: '2026-08-21', date_to: '2026-08-31', qty_blocked: 5, release_days: 7 }, CTX());
  const out = await svc.sweepReleases({ asOfDate: '2026-06-22' });
  assert.equal(out.released.length, 1);
  assert.equal(out.released[0].allocation_id, a1.result.id);
  const stored1 = repos.pmsRepo._allocations.find((a) => a.id === a1.result.id);
  const stored2 = repos.pmsRepo._allocations.find((a) => a.id === a2.result.id);
  assert.equal(stored1.status, 'RELEASED');
  assert.equal(stored2.status, 'ACTIVE');
});
