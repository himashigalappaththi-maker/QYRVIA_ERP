'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands: makePmsCommands } = require('../src/commands/pms');
const { makeCheckinFolioCommands }      = require('../src/commands/pms/checkinFolio');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

async function freshOpenFolio() {
  commandBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  makePmsCommands         ({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeCheckinFolioCommands({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo })
    .forEach((c) => commandBus.register(c));
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'A' }, CTX());
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
  return { db, repos, folioId: ci.result.folio_id };
}

test('C10: cash payment tendered > due returns change + posts PAYMENT line', async () => {
  const { db, repos, folioId } = await freshOpenFolio();
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 850 }, CTX());
  const r = await commandBus.dispatch('pms.folio.payment.cash',
    { folio_id: folioId, amount: 850, tendered: 1000 }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.change, 150);
  const line = repos.folioRepo._store.lines.find((l) => l.id === r.result.line_id);
  assert.equal(line.charge_type, 'PAYMENT');
  assert.equal(line.amount, -850);
  assert.equal(line.metadata.method, 'CASH');
  assert.equal(line.metadata.tendered, 1000);
  assert.equal(line.metadata.change, 150);
  const ev = db.auditRows.find(x => x.event_type === 'folio.payment_received');
  assert.equal(ev.payload.method, 'CASH');
  assert.equal(ev.payload.change, 150);
});

test('C10: cash payment tendered == due returns change=0', async () => {
  const { folioId } = await freshOpenFolio();
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 500 }, CTX());
  const r = await commandBus.dispatch('pms.folio.payment.cash',
    { folio_id: folioId, amount: 500, tendered: 500 }, CTX());
  assert.equal(r.ok, true);
  assert.equal(r.result.change, 0);
});

test('C10: cash payment tendered < due returns tender_insufficient', async () => {
  const { folioId } = await freshOpenFolio();
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 500 }, CTX());
  const r = await commandBus.dispatch('pms.folio.payment.cash',
    { folio_id: folioId, amount: 500, tendered: 200 }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'tender_insufficient');
});

test('C10: cash payment rejects amount=0 / negative', async () => {
  const { folioId } = await freshOpenFolio();
  const a = await commandBus.dispatch('pms.folio.payment.cash',
    { folio_id: folioId, amount: 0, tendered: 50 }, CTX());
  assert.equal(a.error, 'amount_required');
  const b = await commandBus.dispatch('pms.folio.payment.cash',
    { folio_id: folioId, amount: -10, tendered: 50 }, CTX());
  assert.equal(b.error, 'amount_required');
});

test('C10: accountingSensitive guard blocks during business_date lock', async () => {
  const { folioId } = await freshOpenFolio();
  const r = await commandBus.dispatch('pms.folio.payment.cash',
    { folio_id: folioId, amount: 100, tendered: 100 },
    CTX({ businessDateLocked: true }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'business_date_locked');
});
