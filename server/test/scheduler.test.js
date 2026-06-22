'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildScheduler } = require('../src/core/scheduler');
const eventBus           = require('../src/core/eventBus');

const CTX = { requestId: 'rq-j', tenantId: fx.TENANT_A, propertyId: null, actorId: fx.USER_ID, actorName: 'Jane' };

beforeEach(() => { eventBus.reset(); });

test('scheduleJob persists pending row + emits job.scheduled', async () => {
  const r  = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const sch = buildScheduler({ repo: r.schedulerRepo });
  const out = await sch.scheduleJob({
    tenantId: fx.TENANT_A, jobType: 'demo.task', payload: { x: 1 }, runAt: new Date()
  }, CTX);
  assert.ok(out.id);
  assert.equal(r.schedulerRepo._jobs.length, 1);
  assert.equal(r.schedulerRepo._jobs[0].status, 'pending');
  assert.ok(db.auditRows.find(x => x.event_type === 'job.scheduled'));
});

test('executeDueJobs runs registered handler + marks completed + emits job.completed', async () => {
  const r = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const sch = buildScheduler({ repo: r.schedulerRepo });
  let ran = false;
  sch.registerHandler('demo.run', async () => { ran = true; });
  await sch.scheduleJob({ tenantId: fx.TENANT_A, jobType: 'demo.run', payload: {}, runAt: new Date() }, CTX);
  const out = await sch.executeDueJobs({ limit: 10 });
  assert.equal(out.picked, 1);
  assert.equal(out.completed, 1);
  assert.equal(ran, true);
  assert.equal(r.schedulerRepo._jobs[0].status, 'completed');
  assert.ok(db.auditRows.find(x => x.event_type === 'job.completed'));
});

test('executeDueJobs marks pending again when handler throws + attempts < max', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: r.schedulerRepo });
  sch.registerHandler('demo.fail', async () => { throw new Error('boom'); });
  await sch.scheduleJob({ tenantId: fx.TENANT_A, jobType: 'demo.fail', payload: {}, runAt: new Date(), maxAttempts: 3 }, CTX);
  await sch.executeDueJobs({ limit: 10 });
  const j = r.schedulerRepo._jobs[0];
  assert.equal(j.status, 'pending');
  assert.equal(j.attempts, 1);
  assert.match(j.last_error, /boom/);
});

test('executeDueJobs marks failed (terminal) when attempts >= max', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: r.schedulerRepo });
  sch.registerHandler('demo.fail2', async () => { throw new Error('boom2'); });
  await sch.scheduleJob({ tenantId: fx.TENANT_A, jobType: 'demo.fail2', payload: {}, runAt: new Date(), maxAttempts: 1 }, CTX);
  await sch.executeDueJobs({ limit: 10 });
  const j = r.schedulerRepo._jobs[0];
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 1);
});

test('executeDueJobs marks failed when handler not registered', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: r.schedulerRepo });
  await sch.scheduleJob({ tenantId: fx.TENANT_A, jobType: 'demo.no_handler', payload: {}, runAt: new Date() }, CTX);
  const out = await sch.executeDueJobs({ limit: 10 });
  assert.equal(out.failed, 1);
  assert.equal(r.schedulerRepo._jobs[0].last_error, 'handler_not_registered');
});

test('cancelJob cancels pending row + emits job.cancelled', async () => {
  const r = fx.makeFakeRepos();
  const db = fx.makeFakeDb();
  eventBus.init({ db });
  const sch = buildScheduler({ repo: r.schedulerRepo });
  const j = await sch.scheduleJob({ tenantId: fx.TENANT_A, jobType: 'cancel.me', payload: {}, runAt: new Date(Date.now()+86400e3) }, CTX);
  const c = await sch.cancelJob(j.id, CTX);
  assert.equal(c.ok, true);
  assert.equal(r.schedulerRepo._jobs[0].status, 'cancelled');
  assert.ok(db.auditRows.find(x => x.event_type === 'job.cancelled'));
});

test('cancelJob on unknown id -> not found', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: r.schedulerRepo });
  const c = await sch.cancelJob('does-not-exist', CTX);
  assert.equal(c.ok, false);
});

test('jobs scheduled in the future are NOT picked by executeDueJobs', async () => {
  const r = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: r.schedulerRepo });
  await sch.scheduleJob({ tenantId: fx.TENANT_A, jobType: 'future.x', payload: {}, runAt: new Date(Date.now() + 60000) }, CTX);
  const out = await sch.executeDueJobs({ limit: 10 });
  assert.equal(out.picked, 0);
});
