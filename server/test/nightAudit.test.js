'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');
const { buildNightAuditService } = require('../src/services/pms/nightAudit');
const { makeNightAuditCommands } = require('../src/commands/pms/nightAudit');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-21', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

function fresh() {
  commandBus.reset(); eventBus.reset();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  const svc = buildNightAuditService({ nightAuditRepo: repos.nightAuditRepo, pmsRepo: repos.pmsRepo });
  makeNightAuditCommands({ nightAuditService: svc }).forEach((c) => commandBus.register(c));
  return { db, repos, svc };
}

test('nightAudit service: advances business_date by exactly one day', async () => {
  const { svc, repos } = fresh();
  const out = await svc.runForProperty({
    tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
    businessDate: '2026-06-21', triggeredBy: fx.USER_ID
  });
  assert.equal(out.ok, true);
  assert.equal(out.run.business_date, '2026-06-21');
  assert.equal(out.run.next_business_date, '2026-06-22');
  // property advanced + unlocked
  assert.equal(repos.nightAuditRepo._propertyDates.get(fx.PROP_ID), '2026-06-22');
  assert.equal(repos.nightAuditRepo._propertyLocks.get(fx.PROP_ID), false);
});

test('nightAudit service runs registered steps in order and aggregates stats', async () => {
  const { svc } = fresh();
  const callOrder = [];
  svc.registerStep('post-room-charges', async ({ stats }) => { callOrder.push('rc'); stats.rooms_charged = 12; stats.total_room_revenue = 4800; });
  svc.registerStep('flip-no-show',      async ({ stats }) => { callOrder.push('ns'); stats.reservations_no_show = 1; });
  const out = await svc.runForProperty({ tenantId: fx.TENANT_A, propertyId: fx.PROP_ID, businessDate: '2026-06-21' });
  assert.equal(out.ok, true);
  assert.deepEqual(callOrder, ['rc', 'ns']);
  assert.equal(out.stats.rooms_charged, 12);
  assert.equal(out.stats.total_room_revenue, 4800);
  assert.equal(out.stats.reservations_no_show, 1);
});

test('nightAudit service marks FAILED + unlocks the property if a step throws', async () => {
  const { svc, repos } = fresh();
  svc.registerStep('broken', async () => { throw new Error('boom'); });
  const out = await svc.runForProperty({ tenantId: fx.TENANT_A, propertyId: fx.PROP_ID, businessDate: '2026-06-21' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'night_audit_failed');
  // property must NOT remain locked
  assert.equal(repos.nightAuditRepo._propertyLocks.get(fx.PROP_ID), false);
  const run = repos.nightAuditRepo._store.runs[0];
  assert.equal(run.status, 'FAILED');
  assert.match(run.error, /boom/);
});

test('pms.night_audit.run command emits started + completed events', async () => {
  const { db } = fresh();
  const r = await commandBus.dispatch('pms.night_audit.run', {}, CTX());
  assert.equal(r.ok, true);
  assert.equal(r.result.next_business_date, '2026-06-22');
  assert.ok(db.auditRows.find(x => x.event_type === 'night_audit.started'));
  assert.ok(db.auditRows.find(x => x.event_type === 'night_audit.completed'));
});

test('pms.night_audit.run requires ctx.businessDate', async () => {
  fresh();
  const r = await commandBus.dispatch('pms.night_audit.run', {}, CTX({ businessDate: null }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'business_date_required');
});

test('pms.night_audit.run runs EVEN when businessDateLocked=true (acceptsBusinessDateLocked)', async () => {
  fresh();
  const r = await commandBus.dispatch('pms.night_audit.run', {}, CTX({ businessDateLocked: true }));
  assert.equal(r.ok, true);  // accepts the lock; it owns it
});
