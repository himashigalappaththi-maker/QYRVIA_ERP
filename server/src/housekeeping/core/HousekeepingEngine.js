'use strict';

/**
 * HousekeepingEngine - facade composing the task engine with the deterministic
 * optimization engines (priority is applied at task creation; zone clustering +
 * workload balancing drive assignment) and the executive / supervisor
 * dashboards. No AI/LLM.
 */

const { buildHousekeepingTaskEngine } = require('./HousekeepingTaskEngine');
const zone = require('./ZoneOptimizationEngine');
const workload = require('./WorkloadBalancer');
const readiness = require('./ReadinessPredictionEngine');
const { TASK_STATUS, ROOM_HK_STATUS } = require('../models/HousekeepingModels');

function buildHousekeepingEngine({ repo, eventBus, clock } = {}) {
  if (!repo) throw new Error('HousekeepingEngine: repo required');
  const now = clock || (() => Date.now());
  const task = buildHousekeepingTaskEngine({ repo, eventBus, clock });
  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };

  return {
    // ---- task lifecycle (delegated) ----
    createTask: task.createTask, assignTask: task.assignTask, startTask: task.startTask,
    completeTask: task.completeTask, inspectRoom: task.inspectRoom, markReady: task.markReady,
    getTask: task.getTask, listTasks: task.listTasks, getRoomStatus: task.getRoomStatus, listAudit: task.listAudit,

    /** Cluster pending tasks by zone, balance across staff, and persist assignments. */
    async optimizeAssignments(ctx, { employees = [] } = {}) {
      requireProperty(ctx);
      const pending = await task.listTasks(ctx, { status: TASK_STATUS.PENDING });
      const clusters = zone.cluster(pending);
      const { assignments, unassigned } = workload.balance(pending, employees);
      for (const a of assignments) {
        for (const taskId of a.taskIds) {
          // eslint-disable-next-line no-await-in-loop
          await task.assignTask(ctx, { taskId, employeeId: a.employeeId });
        }
      }
      return { assignments, unassigned, clusters: clusters.map((c) => ({ zone: c.zone, taskIds: c.taskIds })) };
    },

    async predictReadiness(ctx, taskId, history = []) {
      const t = await task.getTask(ctx, taskId);
      if (!t) throw new Error('task_not_found');
      return readiness.predict({ taskType: t.taskType, roomType: t.roomType }, history, { now: now() });
    },

    // ---- dashboards ----
    async getExecutiveView(ctx) {
      const propertyId = requireProperty(ctx);
      const statuses = await repo.listRoomStatuses(propertyId);
      const tasks = await task.listTasks(ctx, {});
      const completed = tasks.filter((t) => t.status === TASK_STATUS.COMPLETED && t.completedAt);
      const turnarounds = completed.map((t) => (Date.parse(t.completedAt) - Date.parse(t.createdAt)) / 60000);
      const avgTurnaroundMinutes = turnarounds.length
        ? Math.round((turnarounds.reduce((s, n) => s + n, 0) / turnarounds.length) * 100) / 100 : 0;
      return {
        roomsReady: statuses.filter((s) => s.status === ROOM_HK_STATUS.READY).length,
        roomsDirty: statuses.filter((s) => s.status === ROOM_HK_STATUS.DIRTY).length,
        cleaningBacklog: tasks.filter((t) => ![TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED].includes(t.status)).length,
        avgTurnaroundMinutes
      };
    },

    async getSupervisorView(ctx, { overdueMinutes = 60 } = {}) {
      requireProperty(ctx);
      const tasks = await task.listTasks(ctx, {});
      const cutoff = now() - overdueMinutes * 60 * 1000;
      const staffWorkload = {};
      for (const t of tasks) {
        if (!t.assignedTo) continue;
        if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED].includes(t.status)) continue;
        staffWorkload[t.assignedTo] = staffWorkload[t.assignedTo] || { taskCount: 0, minutes: 0 };
        staffWorkload[t.assignedTo].taskCount += 1;
        staffWorkload[t.assignedTo].minutes += Number(t.estimatedMinutes) || 0;
      }
      return {
        activeTasks: tasks.filter((t) => t.status === TASK_STATUS.IN_PROGRESS).length,
        overdueTasks: tasks.filter((t) => [TASK_STATUS.PENDING, TASK_STATUS.ASSIGNED].includes(t.status)
          && Date.parse(t.createdAt) < cutoff).map((t) => t.id),
        staffWorkload,
        readinessForecast: tasks
          .filter((t) => t.status === TASK_STATUS.IN_PROGRESS)
          .map((t) => ({ taskId: t.id, roomId: t.roomId,
            predictedReadyTime: readiness.predict({ taskType: t.taskType, roomType: t.roomType }, [], { now: now() }).predictedReadyTime }))
      };
    }
  };
}

module.exports = { buildHousekeepingEngine };
