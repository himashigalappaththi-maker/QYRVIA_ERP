'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert   = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');
const identity   = require('../src/services/identity');
const { makeEvent } = require('../src/core/event');

beforeEach(() => {
  commandBus.reset();
  eventBus.reset();
});

test('hasRole: at least one role matches', () => {
  const roles = [{ code: 'finance_manager' }, { code: 'staff' }];
  assert.equal(identity.hasRole(roles, 'finance_manager'), true);
  assert.equal(identity.hasRole(roles, 'staff'),           true);
  assert.equal(identity.hasRole(roles, 'finance_manager', 'gm'), true);
  assert.equal(identity.hasRole(roles, 'gm'),              false);
});

test('hasPermission: explicit grant works', () => {
  const roles = [{ code: 'finance_manager' }];
  const perms = ['ap.invoice.post', 'journal.post'];
  assert.equal(identity.hasPermission(roles, perms, 'ap.invoice.post'), true);
  assert.equal(identity.hasPermission(roles, perms, 'employee.create'), false);
});

test('hasPermission: super_admin bypasses permission matrix', () => {
  const roles = [{ code: 'super_admin' }];
  const perms = []; // empty
  assert.equal(identity.hasPermission(roles, perms, 'anything.at.all'), true);
});

test('commandBus enforces command.permission - denies when missing', async () => {
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  commandBus.register({
    name: 'demo.guarded',
    aggregateType: 'demo',
    permission: 'ap.invoice.post',
    async handler() { return { ok: true, result: {} }; }
  });
  const ctx = {
    requestId: 'r', tenantId: fx.TENANT_A, propertyId: null,
    actorId: fx.USER_ID, actorName: 'Jane',
    roleCodes: ['staff'], roleIds: [], permissions: []
  };
  const r = await commandBus.dispatch('demo.guarded', {}, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'permission_denied');
  // command.denied audit row written
  assert.ok(db.auditRows.find(x => x.event_type === 'command.denied'));
});

test('commandBus enforces command.permission - allows when present', async () => {
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  commandBus.register({
    name: 'demo.guarded.ok',
    aggregateType: 'demo',
    permission: 'ap.invoice.post',
    async handler() { return { ok: true, result: { id: 'x' } }; }
  });
  const ctx = {
    requestId: 'r', tenantId: fx.TENANT_A, propertyId: null,
    actorId: fx.USER_ID, actorName: 'Jane',
    roleCodes: ['finance_manager'], roleIds: [], permissions: ['ap.invoice.post']
  };
  const r = await commandBus.dispatch('demo.guarded.ok', {}, ctx);
  assert.equal(r.ok, true);
});

test('commandBus enforces command.permission - super_admin bypass', async () => {
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  commandBus.register({
    name: 'demo.guarded.super',
    aggregateType: 'demo',
    permission: 'anything.exotic',
    async handler() { return { ok: true, result: { id: 'x' } }; }
  });
  const ctx = {
    requestId: 'r', tenantId: fx.TENANT_A, propertyId: null,
    actorId: fx.USER_ID, actorName: 'Root',
    roleCodes: ['super_admin'], roleIds: [], permissions: []
  };
  const r = await commandBus.dispatch('demo.guarded.super', {}, ctx);
  assert.equal(r.ok, true);
});
