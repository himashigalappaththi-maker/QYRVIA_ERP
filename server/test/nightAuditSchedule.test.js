'use strict';

const fx = require('./_fixtures');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const commandBus = require('../src/core/commandBus');
const eventBus   = require('../src/core/eventBus');
const { buildScheduler } = require('../src/core/scheduler');
const { buildNightAuditService } = require('../src/services/pms/nightAudit');
const { buildNightAuditScheduler } = require('../src/services/pms/nightAuditScheduler');
const { makeNightAuditCommands } = require('../src/commands/pms/nightAudit');
const { buildSettings, _resetCatalog } = require('../src/services/settingsService');
const { bootstrapSettingsCatalog } = require('../src/services/settingsCatalogBoot');

const CTX = (overrides) => Object.assign({
  requestId: 'rq', tenantId: fx.TENANT_A, propertyId: fx.PROP_ID,
  businessDate: '2026-06-22', businessDateLocked: false,
  actorId: fx.USER_ID, actorName: 'Jane',
  roleCodes: ['super_admin'], roleIds: [], permissions: []
}, overrides);

function fresh() {
  commandBus.reset(); eventBus.reset();
  _resetCatalog();
  bootstrapSettingsCatalog();
  const db = fx.makeFakeDb(); eventBus.init({ db });
  const repos = fx.makeFakeRepos();
  const scheduler = buildScheduler({ repo: repos.schedulerRepo });
  const nightAuditService = buildNightAuditService({ nightAuditRepo: repos.nightAuditRepo, pmsRepo: repos.pmsRepo });
  const settingsService = buildSettings({ repo: repos.settingsRepo });
  const nas = buildNightAuditScheduler({
    schedulerRepo: repos.schedulerRepo, scheduler,
    pmsRepo: repos.pmsRepo,
    eventBus, settingsService, commandBus
  });
  for (const c of makeNightAuditCommands({ nightAuditService, nightAuditScheduler: nas })) commandBus.register(c);
  return { db, repos, scheduler, nas, settingsService };
}

test('pms.night_audit.schedule inserts a recurring scheduled_jobs row', async () => {
  const { db, repos } = fresh();
  const r = await commandBus.dispatch('pms.night_audit.schedule',
    { cron: '0 3 * * *', timezone: 'Asia/Colombo' }, CTX());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.cron, '0 3 * * *');
  // scheduler insert is reflected in fake schedulerRepo
  const jobs = repos.schedulerRepo._jobs;
  const job = jobs.find(j => j.job_type === 'pms.night_audit.run');
  assert.ok(job, 'no scheduled_jobs row inserted');
  assert.equal(job.recurrence_rule, '0 3 * * *');
  assert.equal(job.timezone, 'Asia/Colombo');
  // event emitted
  const ev = db.auditRows.find(x => x.event_type === 'night_audit.schedule_configured');
  assert.equal(ev.payload.cron, '0 3 * * *');
});

test('pms.night_audit.schedule rejects invalid cron', async () => {
  fresh();
  const r = await commandBus.dispatch('pms.night_audit.schedule',
    { cron: 'not a cron', timezone: 'UTC' }, CTX());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'scheduler_rejected');
});

test('pms.night_audit.schedule rejects without ctx.propertyId', async () => {
  fresh();
  const r = await commandBus.dispatch('pms.night_audit.schedule',
    { cron: '0 3 * * *' }, CTX({ propertyId: null }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'property_required');
});

test('runStaleCheck emits business_date.stale_detected for stale properties', async () => {
  const { db, repos, nas } = fresh();
  // Seed two properties; only PROP_A has stale business date.
  repos.pmsRepo._seedProperty({ id: fx.PROP_ID, tenant_id: fx.TENANT_A, code: 'A', name: 'A', active: true,
    current_business_date: '2026-06-15', _age_hours: 200 });   // ~8 days stale
  repos.pmsRepo._seedProperty({ id: 'pp2', tenant_id: fx.TENANT_A, code: 'B', name: 'B', active: true,
    current_business_date: '2026-06-22', _age_hours: 2 });
  const out = await nas.runStaleCheck({ thresholdHours: 24 });
  assert.equal(out.found, 1);
  const ev = db.auditRows.find(x => x.event_type === 'business_date.stale_detected');
  assert.ok(ev, 'expected stale event');
  assert.equal(ev.payload.property_id, fx.PROP_ID);
  assert.equal(ev.payload.threshold_hours, 24);
});

test('runStaleCheck is a no-op when no property is stale', async () => {
  const { db, repos, nas } = fresh();
  repos.pmsRepo._seedProperty({ id: 'pX', tenant_id: fx.TENANT_A, code: 'X', name: 'X', active: true,
    current_business_date: '2026-06-22', _age_hours: 2 });
  const out = await nas.runStaleCheck({ thresholdHours: 24 });
  assert.equal(out.found, 0);
  const ev = db.auditRows.find(x => x.event_type === 'business_date.stale_detected');
  assert.equal(ev, undefined);
});

test('settings catalog registers night_audit keys at boot', () => {
  fresh();
  const { lookupSpec } = require('../src/services/settingsService');
  assert.ok(lookupSpec('night_audit', 'cron'));
  assert.ok(lookupSpec('night_audit', 'timezone'));
  assert.ok(lookupSpec('night_audit', 'stale_threshold_hours'));
});
