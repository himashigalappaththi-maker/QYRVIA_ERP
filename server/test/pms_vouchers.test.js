'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands: makePmsCommands } = require('../src/commands/pms');
const { makeVoucherCommands }           = require('../src/commands/pms/vouchers');
const { makeQueries }                   = require('../src/queries/pms');
const { buildSettings, _resetCatalog }  = require('../src/services/settingsService');
const { bootstrapSettingsCatalog }      = require('../src/services/settingsCatalogBoot');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

async function fresh() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  _resetCatalog(); bootstrapSettingsCatalog();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  const settingsService = buildSettings({ repo: repos.settingsRepo });
  makePmsCommands    ({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeVoucherCommands({ pmsRepo: repos.pmsRepo, settingsService }).forEach((c) => commandBus.register(c));
  makeQueries        ({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo }).forEach((q) => queryBus.register(q));

  const agent = await commandBus.dispatch('pms.guest.create',
    { first_name: 'Acme TA', guest_type: 'TRAVEL_AGENT' }, CTX());
  const adult = await commandBus.dispatch('pms.guest.create', { first_name: 'John' }, CTX());
  const rt    = await commandBus.dispatch('pms.roomtype.create',
    { code: 'STD', name: 'Std', max_adults: 2, base_occupancy: 2, extra_bed_capacity: 0 }, CTX());
  return { db, repos, agentId: agent.result.id, adultId: adult.result.id, roomTypeId: rt.result.id };
}

test('C6: pms.voucher.issue creates ISSUED voucher with expires_at from setting', async () => {
  const { db, agentId, roomTypeId } = await fresh();
  const r = await commandBus.dispatch('pms.voucher.issue', {
    voucher_number: 'VCH-001', agent_guest_id: agentId,
    guest_name: 'John Smith', arrival_date: '2026-07-10', departure_date: '2026-07-12',
    room_type_id: roomTypeId, amount: 500
  }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.status, 'ISSUED');
  const ev = db.auditRows.find(x => x.event_type === 'voucher.issued');
  assert.equal(ev.payload.voucher_number, 'VCH-001');
  // default validity = 90 days past departure
  assert.ok(ev.payload.expires_at);
});

test('C6: voucher.issue rejects invalid date range', async () => {
  const { agentId, roomTypeId } = await fresh();
  const r = await commandBus.dispatch('pms.voucher.issue', {
    voucher_number: 'X', agent_guest_id: agentId,
    arrival_date: '2026-07-12', departure_date: '2026-07-10', room_type_id: roomTypeId
  }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_date_range');
});

test('C6: voucher.redeem attaches reservation + transitions ISSUED -> REDEEMED', async () => {
  const { db, agentId, adultId, roomTypeId } = await fresh();
  await commandBus.dispatch('pms.voucher.issue', {
    voucher_number: 'VCH-002', agent_guest_id: agentId,
    arrival_date: '2026-07-10', departure_date: '2026-07-12',
    room_type_id: roomTypeId, amount: 800
  }, CTX());
  const res = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-10', departure_date: '2026-07-12'
  }, CTX());
  const red = await commandBus.dispatch('pms.voucher.redeem',
    { voucher_number: 'VCH-002', reservation_id: res.result.id }, CTX());
  assert.equal(red.ok, true, JSON.stringify(red));
  assert.equal(red.result.status, 'REDEEMED');
  const ev = db.auditRows.find(x => x.event_type === 'voucher.redeemed');
  assert.equal(ev.payload.reservation_id, res.result.id);
  assert.equal(ev.payload.business_date, '2026-06-22');
});

test('C6: double-redeem returns voucher_already_redeemed', async () => {
  const { agentId, adultId, roomTypeId } = await fresh();
  await commandBus.dispatch('pms.voucher.issue', {
    voucher_number: 'VCH-003', agent_guest_id: agentId,
    arrival_date: '2026-07-10', departure_date: '2026-07-12',
    room_type_id: roomTypeId
  }, CTX());
  const res = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-10', departure_date: '2026-07-12'
  }, CTX());
  await commandBus.dispatch('pms.voucher.redeem',
    { voucher_number: 'VCH-003', reservation_id: res.result.id }, CTX());
  const r2 = await commandBus.dispatch('pms.voucher.redeem',
    { voucher_number: 'VCH-003', reservation_id: res.result.id }, CTX());
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'voucher_already_redeemed');
});

test('C6: cancelled voucher cannot be redeemed', async () => {
  const { agentId, adultId, roomTypeId } = await fresh();
  await commandBus.dispatch('pms.voucher.issue', {
    voucher_number: 'VCH-004', agent_guest_id: agentId,
    arrival_date: '2026-07-10', departure_date: '2026-07-12',
    room_type_id: roomTypeId
  }, CTX());
  await commandBus.dispatch('pms.voucher.cancel',
    { voucher_number: 'VCH-004', reason: 'agent_request' }, CTX());
  const res = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-10', departure_date: '2026-07-12'
  }, CTX());
  const r = await commandBus.dispatch('pms.voucher.redeem',
    { voucher_number: 'VCH-004', reservation_id: res.result.id }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'voucher_cancelled');
});

test('C6: voucher.redeem is accountingSensitive - blocked under lock', async () => {
  const { agentId, adultId, roomTypeId } = await fresh();
  await commandBus.dispatch('pms.voucher.issue', {
    voucher_number: 'VCH-005', agent_guest_id: agentId,
    arrival_date: '2026-07-10', departure_date: '2026-07-12',
    room_type_id: roomTypeId
  }, CTX());
  const res = await commandBus.dispatch('pms.reservation.create', {
    holder_guest_id: adultId, primary_adult_guest_id: adultId,
    room_type_id: roomTypeId, arrival_date: '2026-07-10', departure_date: '2026-07-12'
  }, CTX());
  const r = await commandBus.dispatch('pms.voucher.redeem',
    { voucher_number: 'VCH-005', reservation_id: res.result.id },
    CTX({ businessDateLocked: true }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'business_date_locked');
});

test('C6: pms.voucher.byNumber returns the voucher', async () => {
  const { agentId, roomTypeId } = await fresh();
  await commandBus.dispatch('pms.voucher.issue', {
    voucher_number: 'VCH-006', agent_guest_id: agentId,
    arrival_date: '2026-07-10', departure_date: '2026-07-12',
    room_type_id: roomTypeId
  }, CTX());
  const q = await queryBus.execute('pms.voucher.byNumber', { voucher_number: 'VCH-006' }, CTX());
  assert.equal(q.ok, true);
  assert.equal(q.data.voucher_number, 'VCH-006');
});
