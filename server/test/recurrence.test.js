'use strict';

const fx = require('./_fixtures');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { parseCron, nextRun } = require('../src/core/cron');
const { buildScheduler } = require('../src/core/scheduler');
const eventBus = require('../src/core/eventBus');

const CTX = { tenantId: fx.TENANT_A, propertyId: null, requestId: 'rq-cron', actorId: fx.USER_ID, actorName: 'Jane' };

beforeEach(() => { eventBus.reset(); });

test('parseCron accepts a 5-field expression', () => {
  const c = parseCron('0 3 * * *');
  assert.deepEqual(c.minute, [0]);
  assert.deepEqual(c.hour, [3]);
  assert.equal(c.dayOfMonth.length, 31);
  assert.equal(c.dayOfWeek.length,  7);
});

test('parseCron handles ranges, steps, lists', () => {
  const c = parseCron('*/15 9-17 1-7 * 1-5');
  assert.deepEqual(c.minute, [0,15,30,45]);
  assert.deepEqual(c.hour,   [9,10,11,12,13,14,15,16,17]);
  assert.deepEqual(c.dayOfWeek, [1,2,3,4,5]);
});

test('parseCron rejects garbage', () => {
  assert.throws(() => parseCron('not a cron'));
  assert.throws(() => parseCron('80 * * * *'));     // 80 minute
  assert.throws(() => parseCron('* 25 * * *'));     // 25 hour
  assert.throws(() => parseCron('* * 32 * *'));     // 32 day
});

test('nextRun finds the next matching minute', () => {
  // Always-match cron -> next minute boundary
  const n = nextRun('* * * * *', '2026-06-21T10:30:15Z');
  // Next minute boundary AFTER 10:30:15 is 10:31:00
  assert.equal(n, '2026-06-21T10:31:00.000Z');
});

test('nextRun for daily 03:00', () => {
  const n = nextRun('0 3 * * *', '2026-06-21T05:00:00Z');
  assert.equal(n, '2026-06-22T03:00:00.000Z');
});

test('nextRun respects day-of-week mon-fri', () => {
  // 2026-06-21 is a Sunday. Expect Monday 06-22 at 09:00.
  const n = nextRun('0 9 * * 1-5', '2026-06-21T08:00:00Z');
  assert.equal(n, '2026-06-22T09:00:00.000Z');
});

test('scheduleJob with recurrence_rule rejects bad cron', async () => {
  const repos = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: repos.schedulerRepo });
  await assert.rejects(
    sch.scheduleJob({ tenantId: fx.TENANT_A, jobType: 'x', recurrenceRule: 'garbage' }, CTX),
    /invalid recurrence_rule/
  );
});

test('scheduleJob with recurrence_rule sets next_run_at', async () => {
  const repos = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: repos.schedulerRepo });
  await sch.scheduleJob({ tenantId: fx.TENANT_A, jobType: 'x', recurrenceRule: '0 3 * * *' }, CTX);
  const j = repos.schedulerRepo._jobs[0];
  assert.equal(j.recurrence_rule, '0 3 * * *');
  assert.ok(j.next_run_at);
  assert.ok(j.run_at);
});

test('recurring job: after run, status returns to pending with new run_at', async () => {
  const repos = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: repos.schedulerRepo });
  sch.registerHandler('cron.daily', async () => {});
  await sch.scheduleJob({
    tenantId: fx.TENANT_A, jobType: 'cron.daily',
    recurrenceRule: '* * * * *', runAt: new Date()
  }, CTX);
  const out = await sch.executeDueJobs({ limit: 5 });
  assert.equal(out.completed, 1);
  const j = repos.schedulerRepo._jobs[0];
  assert.equal(j.status, 'pending', 'recurring job back to pending');
  assert.ok(j.next_run_at, 'next_run_at set');
});

test('recurring job moves to dead_letter after max_attempts', async () => {
  const repos = fx.makeFakeRepos();
  eventBus.init({ db: fx.makeFakeDb() });
  const sch = buildScheduler({ repo: repos.schedulerRepo });
  sch.registerHandler('cron.fail', async () => { throw new Error('always fails'); });
  await sch.scheduleJob({
    tenantId: fx.TENANT_A, jobType: 'cron.fail',
    recurrenceRule: '* * * * *', runAt: new Date(), maxAttempts: 1
  }, CTX);
  await sch.executeDueJobs({ limit: 5 });
  const j = repos.schedulerRepo._jobs[0];
  assert.equal(j.status, 'dead_letter');
  assert.match(j.dead_letter_reason, /always fails/);
});
