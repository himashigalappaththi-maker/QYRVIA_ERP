'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands: makePmsCommands } = require('../src/commands/pms');
const { makeCheckinFolioCommands }      = require('../src/commands/pms/checkinFolio');
const { makeInvoiceCommands }           = require('../src/commands/pms/invoices');
const { makeQueries }                   = require('../src/queries/pms');
const { buildSettings, _resetCatalog }  = require('../src/services/settingsService');
const { bootstrapSettingsCatalog }      = require('../src/services/settingsCatalogBoot');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

async function freshSettledFolio() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  _resetCatalog(); bootstrapSettingsCatalog();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'NEG', name: 'Negombo', currency: 'LKR', active: true });
  const settingsService = buildSettings({ repo: repos.settingsRepo });
  makePmsCommands         ({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeCheckinFolioCommands({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo, housekeepingRepo: repos.housekeepingRepo })
    .forEach((c) => commandBus.register(c));
  makeInvoiceCommands     ({ folioRepo: repos.folioRepo, pmsRepo: repos.pmsRepo, settingsService })
    .forEach((c) => commandBus.register(c));
  makeQueries             ({ pmsRepo: repos.pmsRepo, folioRepo: repos.folioRepo })
    .forEach((q) => queryBus.register(q));

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
  // Make folio settled (balance=0)
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: ci.result.folio_id, charge_type: 'ROOM', amount: 100 }, CTX());
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: ci.result.folio_id, charge_type: 'PAYMENT', amount: -100 }, CTX());
  return { db, repos, folioId: ci.result.folio_id };
}

test('C9: issue invoice from settled folio creates PROPCODE-INV-YYYY-000001', async () => {
  const { db, folioId } = await freshSettledFolio();
  const r = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.result.invoice_number, /^NEG-INV-\d{4}-000001$/);
  assert.equal(r.result.status, 'ISSUED');
  const ev = db.auditRows.find(x => x.event_type === 'invoice.issued');
  assert.equal(ev.payload.invoice_number, r.result.invoice_number);
});

test('C9: issue from non-zero-balance folio is rejected', async () => {
  const { folioId } = await freshSettledFolio();
  // Add another charge so balance != 0
  await commandBus.dispatch('pms.folio.charge.post', { folio_id: folioId, charge_type: 'ROOM', amount: 50 }, CTX());
  const r = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'folio_has_balance');
});

test('C9: void invoice requires reason; success transitions to VOIDED', async () => {
  const { db, folioId } = await freshSettledFolio();
  const inv = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  const v1  = await commandBus.dispatch('pms.invoice.void', { invoice_id: inv.result.id }, CTX());
  assert.equal(v1.error, 'reason_required');
  const v2  = await commandBus.dispatch('pms.invoice.void',
    { invoice_id: inv.result.id, reason: 'duplicate' }, CTX());
  assert.equal(v2.ok, true);
  assert.equal(v2.result.status, 'VOIDED');
  const ev  = db.auditRows.find(x => x.event_type === 'invoice.voided');
  assert.equal(ev.payload.reason, 'duplicate');
});

test('C9: cannot void an already-voided invoice', async () => {
  const { folioId } = await freshSettledFolio();
  const inv = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  await commandBus.dispatch('pms.invoice.void',
    { invoice_id: inv.result.id, reason: 'r1' }, CTX());
  const v2 = await commandBus.dispatch('pms.invoice.void',
    { invoice_id: inv.result.id, reason: 'r2' }, CTX());
  assert.equal(v2.ok, false);
  assert.equal(v2.error, 'invalid_transition');
});

test('C9: pms.invoice.byNumber finds the invoice', async () => {
  const { folioId } = await freshSettledFolio();
  const inv = await commandBus.dispatch('pms.invoice.issue_from_folio', { folio_id: folioId }, CTX());
  const r = await queryBus.execute('pms.invoice.byNumber', { invoice_number: inv.result.invoice_number }, CTX());
  assert.equal(r.ok, true);
  assert.equal(r.data.id, inv.result.id);
});

test('C9: invoice.issue is accountingSensitive - blocked while lock is held', async () => {
  const { folioId } = await freshSettledFolio();
  const r = await commandBus.dispatch('pms.invoice.issue_from_folio',
    { folio_id: folioId }, CTX({ businessDateLocked: true }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'business_date_locked');
});
