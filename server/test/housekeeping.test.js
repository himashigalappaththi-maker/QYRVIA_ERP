'use strict';

/** Phase 15 - Housekeeping Optimization Engine (deterministic; no AI). */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test_db';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'test-jwt-secret-with-enough-length-1234567890';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryHousekeepingRepo } = require('../src/housekeeping/repository/housekeepingRepo.memory');
const { buildHousekeepingEngine } = require('../src/housekeeping/core/HousekeepingEngine');
const { buildHousekeepingSubscriber } = require('../src/housekeeping/services/housekeepingSubscriber');
const priority = require('../src/housekeeping/core/PriorityEngine');
const zone = require('../src/housekeeping/core/ZoneOptimizationEngine');
const workload = require('../src/housekeeping/core/WorkloadBalancer');
const readiness = require('../src/housekeeping/core/ReadinessPredictionEngine');
const { TASK_TYPE, TASK_STATUS } = require('../src/housekeeping/models/HousekeepingModels');

const CTX = (propertyId, userId = 'u1') => ({ tenantId: 't1', propertyId, requestId: 'rq', userId });

function fresh() {
  const events = [];
  const eventBus = { publish: async (e) => { events.push(e); }, subscribe: () => () => {} };
  const hk = buildHousekeepingEngine({ repo: buildMemoryHousekeepingRepo(), eventBus });
  return { events, hk };
}

test('PriorityEngine: deterministic 0-100 weighted score', () => {
  assert.equal(priority.score({ vipGuest: true, arrivingGuestToday: true }), 55);   // 25 + 30
  assert.equal(priority.score({ occupancyPressure: 1 }), 20);
  assert.equal(priority.score({ vipGuest: true, arrivingGuestToday: true, earlyCheckInRisk: true, suiteCategory: true, checkoutCompleted: true, maintenanceDependency: true, occupancyPressure: 1 }), 100);
  assert.equal(priority.score({}), 0);
});

test('ZoneOptimizationEngine: clusters by zone, highest priority first', () => {
  const tasks = [
    { id: 'a', zone: 'F2', priority: 50, roomId: '201' },
    { id: 'b', zone: 'F1', priority: 40, roomId: '101' },
    { id: 'c', zone: 'F1', priority: 90, roomId: '102' }
  ];
  const clusters = zone.cluster(tasks);
  assert.deepEqual(clusters.map((c) => c.zone), ['F1', 'F2']);
  assert.deepEqual(clusters[0].taskIds, ['c', 'b']);   // F1 by priority desc
});

test('WorkloadBalancer: balances within capacity, overflow is unassigned (no overload)', () => {
  const tasks = ['t1', 't2', 't3', 't4', 't5'].map((id, i) => ({ id, priority: 90 - i, estimatedMinutes: 30 }));
  const employees = [{ employeeId: 'e1', capacityMinutes: 60 }, { employeeId: 'e2', capacityMinutes: 60 }];
  const { assignments, unassigned } = workload.balance(tasks, employees);
  for (const a of assignments) assert.ok(a.workloadMinutes <= 60, 'no overload');
  assert.equal(assignments.reduce((s, a) => s + a.taskIds.length, 0), 4);
  assert.equal(unassigned.length, 1);                  // 5*30=150 > 120 capacity
});

test('ReadinessPredictionEngine: deterministic estimate + confidence', () => {
  const noHist = readiness.predict({ taskType: 'CHECKOUT_CLEANING', roomType: 'SUITE' }, [], { now: 0 });
  assert.equal(noHist.estimatedMinutes, 45);           // 30 base * 1.5 suite
  assert.equal(noHist.confidence, 0.5);
  const withHist = readiness.predict({ taskType: 'CHECKOUT_CLEANING' }, [40, 50], { now: 0 });
  assert.equal(withHist.estimatedMinutes, 45);         // avg
  assert.equal(withHist.confidence, 0.4);              // 2/5
});

test('task lifecycle drives room DIRTY->CLEANING->CLEAN->INSPECTED->READY with audit', async () => {
  const { hk } = fresh();
  const ctx = CTX('PA', 'cleaner-1');
  const task = await hk.createTask(ctx, { roomId: 'RM1', taskType: TASK_TYPE.CHECKOUT_CLEANING, factors: { checkoutCompleted: true } });
  assert.equal(await hk.getRoomStatus(ctx, 'RM1'), 'DIRTY');
  await hk.assignTask(ctx, { taskId: task.id, employeeId: 'e1' });
  await hk.startTask(ctx, { taskId: task.id });
  assert.equal(await hk.getRoomStatus(ctx, 'RM1'), 'CLEANING');
  await hk.completeTask(ctx, { taskId: task.id });
  assert.equal(await hk.getRoomStatus(ctx, 'RM1'), 'CLEAN');
  await hk.inspectRoom(ctx, { roomId: 'RM1', passed: true });
  assert.equal(await hk.getRoomStatus(ctx, 'RM1'), 'INSPECTED');
  await hk.markReady(ctx, { roomId: 'RM1' });
  assert.equal(await hk.getRoomStatus(ctx, 'RM1'), 'READY');

  const audit = await hk.listAudit(ctx, { roomId: 'RM1' });
  assert.ok(audit.length >= 5);
  assert.ok(audit.every((a) => a.propertyId === 'PA' && a.userId === 'cleaner-1' && a.at));
});

test('failed inspection rolls the room back to CLEANING (audited)', async () => {
  const { hk } = fresh();
  const ctx = CTX('PA');
  const t = await hk.createTask(ctx, { roomId: 'RM2', taskType: TASK_TYPE.CHECKOUT_CLEANING });
  await hk.startTask(ctx, { taskId: t.id });
  await hk.completeTask(ctx, { taskId: t.id });        // CLEAN
  const back = await hk.inspectRoom(ctx, { roomId: 'RM2', passed: false });
  assert.equal(back, 'CLEANING');
  const audit = await hk.listAudit(ctx, { roomId: 'RM2' });
  assert.ok(audit.some((a) => a.action === 'ROLLBACK' && a.reason === 'inspection_failed'));
});

test('optimizeAssignments clusters + balances pending tasks and persists assignment', async () => {
  const { hk } = fresh();
  const ctx = CTX('PA');
  await hk.createTask(ctx, { roomId: '101', taskType: TASK_TYPE.CHECKOUT_CLEANING, zone: 'F1', factors: { vipGuest: true } });
  await hk.createTask(ctx, { roomId: '102', taskType: TASK_TYPE.STAYOVER_CLEANING, zone: 'F1' });
  await hk.createTask(ctx, { roomId: '201', taskType: TASK_TYPE.CHECKOUT_CLEANING, zone: 'F2' });
  const { assignments, unassigned } = await hk.optimizeAssignments(ctx, { employees: [{ employeeId: 'e1', capacityMinutes: 120 }, { employeeId: 'e2', capacityMinutes: 120 }] });
  const totalAssigned = assignments.reduce((s, a) => s + a.taskIds.length, 0);
  assert.equal(totalAssigned + unassigned.length, 3);
  const stillPending = await hk.listTasks(ctx, { status: TASK_STATUS.PENDING });
  assert.equal(stillPending.length, unassigned.length);   // assigned ones left PENDING
});

test('dashboards report counts deterministically', async () => {
  const { hk } = fresh();
  const ctx = CTX('PA');
  const t = await hk.createTask(ctx, { roomId: 'RM1', taskType: TASK_TYPE.CHECKOUT_CLEANING });
  await hk.startTask(ctx, { taskId: t.id });
  await hk.completeTask(ctx, { taskId: t.id });
  await hk.inspectRoom(ctx, { roomId: 'RM1' });
  await hk.markReady(ctx, { roomId: 'RM1' });
  const exec = await hk.getExecutiveView(ctx);
  assert.equal(exec.roomsReady, 1);
  assert.ok('cleaningBacklog' in exec && 'avgTurnaroundMinutes' in exec);
  const sup = await hk.getSupervisorView(ctx);
  assert.ok('activeTasks' in sup && Array.isArray(sup.overdueTasks));
});

test('multi-property isolation', async () => {
  const { hk } = fresh();
  const t = await hk.createTask(CTX('PA'), { roomId: 'RM1', taskType: TASK_TYPE.CHECKOUT_CLEANING });
  assert.equal((await hk.listTasks(CTX('PB'), {})).length, 0);
  assert.equal(await hk.getTask(CTX('PB'), t.id), null);
  assert.equal(await hk.getRoomStatus(CTX('PB'), 'RM1'), 'OCCUPIED');  // PB's view unaffected
});

test('event subscriber creates tasks from stay/room/vip events', async () => {
  const eventBus = require('../src/core/eventBus');
  eventBus.reset();
  eventBus.init({ db: { auditRows: [], async insertAuditEvent(ev) { this.auditRows.push(ev); } } });
  const hk = buildHousekeepingEngine({ repo: buildMemoryHousekeepingRepo(), eventBus });
  buildHousekeepingSubscriber({ eventBus, housekeeping: hk });
  const base = { tenant_id: 't1', property_id: 'PA', actor_id: 'frontdesk' };

  await eventBus.publish(Object.assign({ event_type: 'stay.ended', event_id: 'e1', payload: { room_id: 'RM1' } }, base));
  await eventBus.publish(Object.assign({ event_type: 'stay.room_moved', event_id: 'e2', payload: { from_room_id: 'RM2' } }, base));
  await eventBus.publish(Object.assign({ event_type: 'vip.arrival.flagged', event_id: 'e3', payload: { room_id: 'RM3', suite: true } }, base));

  const tasks = await hk.listTasks(CTX('PA'), {});
  const byType = tasks.reduce((m, t) => { m[t.taskType] = (m[t.taskType] || 0) + 1; return m; }, {});
  assert.equal(byType.CHECKOUT_CLEANING, 1);
  assert.equal(byType.TRANSFER_CLEANING, 1);
  assert.equal(byType.VIP_PREPARATION, 1);
  const vip = tasks.find((t) => t.taskType === 'VIP_PREPARATION');
  assert.ok(vip.priority >= 55, 'VIP prep gets high priority');
});
