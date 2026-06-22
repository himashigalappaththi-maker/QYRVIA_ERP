'use strict';

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
const { makeQueries }                   = require('../src/queries/pms');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

async function freshFolio() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  makePmsCommands         ({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeCheckinFolioCommands({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo })
    .forEach((c) => commandBus.register(c));
  const svc = buildPaymentAllocationService({ folioRepo: repos.folioRepo, pmsRepo: repos.pmsRepo });
  makePaymentAllocationCommands({ paymentAllocationService: svc }).forEach((c) => commandBus.register(c));
  makeQueries({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo }).forEach((q) => queryBus.register(q));

  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'A', last_name: 'A' }, CTX());
  const rt    = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, max_children: 0, base_occupancy: 2, extra_bed_capacity: 0 }, CTX());
  const room  = await commandBus.dispatch('pms.room.create', { room_type_id: rt.result.id, room_number: '101' }, CTX());
  const res   = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adult.result.id, primary_adult_guest_id: adult.result.id,
    room_type_id: rt.result.id, arrival_date: '2026-07-01', departure_date: '2026-07-03'
  }, CTX());
  await commandBus.dispatch('pms.reservation.confirm', { reservation_id: res.result.id }, CTX());
  const ci = await commandBus.dispatch('pms.reservation.checkin',
    { reservation_id: res.result.id, assigned_room_id: room.result.id }, CTX());
  return { db, repos, folioId: ci.result.folio_id };
}

test('C8: payment auto-allocates oldest-first across two charges', async () => {
  const { repos, folioId } = await freshFolio();
  // Post two ROOM charges.
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 100, description: 'night 1' }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 80,  description: 'night 2' }, CTX());
  // Post a payment covering both.
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'PAYMENT', amount: -180 }, CTX());
  const lines = repos.folioRepo._store.lines.filter((l) => l.folio_id === folioId);
  const payment = lines.find((l) => l.charge_type === 'PAYMENT');
  const r = await commandBus.dispatch('pms.folio.payment.allocate',
    { folio_id: folioId, payment_line_id: payment.id }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.allocations.length, 2);
  assert.equal(r.result.unallocated_remainder, 0);
});

test('C8: payment > sum-of-charges leaves remainder unallocated', async () => {
  const { repos, folioId } = await freshFolio();
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 50 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'PAYMENT', amount: -120 }, CTX());
  const payment = repos.folioRepo._store.lines.find((l) => l.charge_type === 'PAYMENT' && l.folio_id === folioId);
  const r = await commandBus.dispatch('pms.folio.payment.allocate',
    { folio_id: folioId, payment_line_id: payment.id }, CTX());
  assert.equal(r.ok, true);
  assert.equal(r.result.unallocated_remainder, 70);
});

test('C8: explicit allocation map honoured + emits folio.payment_allocated', async () => {
  const { db, repos, folioId } = await freshFolio();
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 100 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 100 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'PAYMENT', amount: -50 }, CTX());
  const lines = repos.folioRepo._store.lines.filter((l) => l.folio_id === folioId);
  const charges = lines.filter((l) => l.charge_type === 'ROOM');
  const payment = lines.find((l) => l.charge_type === 'PAYMENT');
  const r = await commandBus.dispatch('pms.folio.payment.allocate', {
    folio_id: folioId, payment_line_id: payment.id,
    allocations: [{ charge_line_id: charges[1].id, amount: 50 }]    // pay newest only
  }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.allocations[0].charge_line_id, charges[1].id);
  const ev = db.auditRows.find(x => x.event_type === 'folio.payment_allocated');
  assert.equal(ev.payload.allocation_count, 1);
});

test('C8: allocation exceeds charge balance is rejected', async () => {
  const { repos, folioId } = await freshFolio();
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 50 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'PAYMENT', amount: -50 }, CTX());
  const lines = repos.folioRepo._store.lines.filter((l) => l.folio_id === folioId);
  const charge  = lines.find((l) => l.charge_type === 'ROOM');
  const payment = lines.find((l) => l.charge_type === 'PAYMENT');
  const r = await commandBus.dispatch('pms.folio.payment.allocate', {
    folio_id: folioId, payment_line_id: payment.id,
    allocations: [{ charge_line_id: charge.id, amount: 100 }]
  }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'allocation_exceeds_charge');
});

test('C8: allocation refused when payment_line_id is actually a charge line', async () => {
  const { repos, folioId } = await freshFolio();
  const chargeRes = await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 100 }, CTX());
  const r = await commandBus.dispatch('pms.folio.payment.allocate',
    { folio_id: folioId, payment_line_id: chargeRes.result.line_id }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'line_is_not_a_payment');
});

test('C8: accountingSensitive guard blocks during business_date lock', async () => {
  const { repos, folioId } = await freshFolio();
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 100 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'PAYMENT', amount: -100 }, CTX());
  const payment = repos.folioRepo._store.lines.find((l) => l.charge_type === 'PAYMENT' && l.folio_id === folioId);
  const r = await commandBus.dispatch('pms.folio.payment.allocate',
    { folio_id: folioId, payment_line_id: payment.id },
    CTX({ businessDateLocked: true }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'business_date_locked');
});

test('C8: GET allocations.list returns all allocations on a folio', async () => {
  const { repos, folioId } = await freshFolio();
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 100 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'PAYMENT', amount: -100 }, CTX());
  const payment = repos.folioRepo._store.lines.find((l) => l.charge_type === 'PAYMENT' && l.folio_id === folioId);
  await commandBus.dispatch('pms.folio.payment.allocate', { folio_id: folioId, payment_line_id: payment.id }, CTX());
  const list = await queryBus.execute('pms.folio.allocations.list', { folio_id: folioId }, CTX());
  assert.equal(list.ok, true);
  assert.equal(list.data.length, 1);
});
