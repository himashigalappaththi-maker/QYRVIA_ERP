'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const queryBus   = require('../src/core/queryBus');
const eventBus   = require('../src/core/eventBus');
const { makeCommands } = require('../src/commands/pms');
const { makeQueries  } = require('../src/queries/pms');
const { evaluateChild, classifyParty } = require('../src/services/pms/childPolicy');

const CTX = {
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
};

function freshBuses() {
  commandBus.reset(); queryBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'AGH', name: 'Acme', currency: 'LKR', active: true });
  makeCommands({ pmsRepo: repos.pmsRepo }).forEach((c) => commandBus.register(c));
  makeQueries ({ pmsRepo: repos.pmsRepo }).forEach((q) => queryBus.register(q));
  return { db, repos };
}

// ----- guest tests ----------------------------------------------------------

test('guest.create individual + listing finds it', async () => {
  freshBuses();
  const g = await commandBus.dispatch('pms.guest.create', { first_name: 'Alice', last_name: 'Smith', guest_type: 'INDIVIDUAL', email: 'a@x.com' }, CTX);
  assert.equal(g.ok, true);
  const list = await queryBus.execute('pms.guest.list', {}, CTX);
  assert.equal(list.data.length, 1);
});

test('guest.create rejects invalid type', async () => {
  freshBuses();
  const g = await commandBus.dispatch('pms.guest.create', { first_name: 'X', guest_type: 'BOGUS' }, CTX);
  assert.equal(g.ok, false);
  assert.equal(g.error, 'invalid_guest_type');
});

test('guest.create requires first_name', async () => {
  freshBuses();
  const g = await commandBus.dispatch('pms.guest.create', { guest_type: 'INDIVIDUAL' }, CTX);
  assert.equal(g.ok, false);
});

test('guest.create supports corporate / agent / DMC / tour', async () => {
  freshBuses();
  const types = ['CORPORATE','TRAVEL_AGENT','DMC','TOUR_ORGANIZER'];
  for (const t of types) {
    const r = await commandBus.dispatch('pms.guest.create', { first_name: 'Org-' + t, guest_type: t, organization_name: 'Org ' + t }, CTX);
    assert.equal(r.ok, true, 'failed for ' + t);
  }
  const list = await queryBus.execute('pms.guest.list', {}, CTX);
  assert.equal(list.data.length, 4);
});

test('guest.blacklist flips flag + emits event', async () => {
  const { db } = freshBuses();
  const g = await commandBus.dispatch('pms.guest.create', { first_name: 'Bob' }, CTX);
  const b = await commandBus.dispatch('pms.guest.blacklist', { guest_id: g.result.id, blacklisted: true }, CTX);
  assert.equal(b.ok, true);
  assert.equal(b.result.blacklisted_flag, true);
  assert.ok(db.auditRows.find(x => x.event_type === 'guest.blacklist_updated'));
});

test('guest.list search filters by name', async () => {
  freshBuses();
  await commandBus.dispatch('pms.guest.create', { first_name: 'Alpha' }, CTX);
  await commandBus.dispatch('pms.guest.create', { first_name: 'Bravo' }, CTX);
  const r = await queryBus.execute('pms.guest.list', { q: 'alpha' }, CTX);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].first_name, 'Alpha');
});

// ----- child policy --------------------------------------------------------

test('childpolicy.create + load shows categories', async () => {
  freshBuses();
  const p = await commandBus.dispatch('pms.childpolicy.create', {
    code: 'STD', name: 'Standard',
    categories: [
      { code: 'INFANT',  name: 'Infant',  age_from: 0,  age_to: 2,  stay_charge_pct: 0,  counts_in_occupancy: false },
      { code: 'CHILD_A', name: 'Child A', age_from: 3,  age_to: 6,  stay_charge_pct: 25, counts_in_occupancy: true  },
      { code: 'CHILD_B', name: 'Child B', age_from: 7,  age_to: 12, stay_charge_pct: 50, requires_extra_bed: true, extra_bed_charge: 1500 }
    ]
  }, CTX);
  assert.equal(p.ok, true);
  assert.equal(p.result.categories, 3);
  const loaded = await queryBus.execute('pms.childpolicy.byId', { id: p.result.id }, CTX);
  assert.equal(loaded.data.categories.length, 3);
});

test('childpolicy.create rejects bad age range', async () => {
  freshBuses();
  const p = await commandBus.dispatch('pms.childpolicy.create', {
    code: 'BAD', name: 'Bad',
    categories: [{ code: 'X', name: 'X', age_from: 5, age_to: 2 }]
  }, CTX);
  assert.equal(p.ok, false);
});

// ----- pure child-policy engine -------------------------------------------

test('evaluateChild: matches first category by age', () => {
  const policy = { categories: [
    { code: 'INFANT', name: 'Infant', age_from: 0, age_to: 2, stay_charge_pct: 0 },
    { code: 'CHILD',  name: 'Child',  age_from: 3, age_to: 12, stay_charge_pct: 50 }
  ]};
  assert.equal(evaluateChild(policy, 1).category, 'INFANT');
  assert.equal(evaluateChild(policy, 7).category, 'CHILD');
  assert.equal(evaluateChild(policy, 18), null);
});

test('classifyParty refuses 0 adults', () => {
  const cls = classifyParty({ adults: 0, children: [], policy: { categories: [] }, roomType: {} });
  assert.equal(cls.oversold, true);
  assert.ok(cls.reasons.includes('adults_required'));
});

test('classifyParty: child counts in occupancy when category says so', () => {
  const policy = { categories: [{ code: 'C', name: 'C', age_from: 0, age_to: 12, counts_in_occupancy: true }] };
  const cls = classifyParty({ adults: 2, children: [5, 7], policy,
    roomType: { max_adults: 2, max_children: 2, base_occupancy: 2, extra_bed_capacity: 2 } });
  assert.equal(cls.occupancy_total, 4);
});

test('classifyParty: triggers extra_bed when category requires it', () => {
  const policy = { categories: [{ code: 'C', name: 'C', age_from: 0, age_to: 12, requires_extra_bed: true }] };
  const cls = classifyParty({ adults: 1, children: [10], policy,
    roomType: { max_adults: 2, max_children: 1, base_occupancy: 2, extra_bed_capacity: 1 } });
  assert.equal(cls.extra_beds_needed, 1);
});

test('classifyParty: oversold when extra beds exceed capacity', () => {
  const policy = { categories: [{ code: 'C', name: 'C', age_from: 0, age_to: 12, requires_extra_bed: true }] };
  const cls = classifyParty({ adults: 1, children: [4, 6], policy,
    roomType: { max_adults: 2, max_children: 2, base_occupancy: 2, extra_bed_capacity: 1 } });
  assert.equal(cls.oversold, true);
  assert.ok(cls.reasons.includes('exceeds_extra_bed_capacity'));
});

test('classifyParty: child age outside policy is flagged + counts defensively', () => {
  const policy = { categories: [{ code: 'C', name: 'C', age_from: 0, age_to: 2 }] };
  const cls = classifyParty({ adults: 1, children: [10], policy,
    roomType: { max_adults: 2, max_children: 2, base_occupancy: 2, extra_bed_capacity: 1 } });
  assert.ok(cls.reasons.includes('child_age_outside_policy'));
});
