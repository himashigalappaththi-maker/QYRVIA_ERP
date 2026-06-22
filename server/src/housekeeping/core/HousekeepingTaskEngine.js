'use strict';

/**
 * HousekeepingTaskEngine - task lifecycle + room housekeeping status flow with
 * a full audit trail (propertyId, userId, timestamp). Deterministic.
 *
 * Room flow: OCCUPIED -> DIRTY -> CLEANING -> CLEAN -> INSPECTED -> READY,
 * with audited rollback (e.g. a failed inspection sends the room back to
 * CLEANING). Phase 15 owns this status; it never writes to the Room engine.
 */

const models = require('../models/HousekeepingModels');
const priority = require('./PriorityEngine');
const readiness = require('./ReadinessPredictionEngine');
const { TASK_TYPE, TASK_STATUS, ROOM_HK_STATUS, canAdvance, isRollback, makeTask } = models;

let makeEvent = null;
try { ({ makeEvent } = require('../../core/event')); } catch (_) { /* optional */ }

const CLEANING_TASKS = new Set([
  TASK_TYPE.CHECKOUT_CLEANING, TASK_TYPE.STAYOVER_CLEANING, TASK_TYPE.DEEP_CLEANING,
  TASK_TYPE.TRANSFER_CLEANING, TASK_TYPE.VIP_PREPARATION
]);

function buildHousekeepingTaskEngine({ repo, eventBus, clock } = {}) {
  if (!repo) throw new Error('HousekeepingTaskEngine: repo required');
  const now = clock || (() => Date.now());

  const requireProperty = (ctx) => { if (!ctx || !ctx.propertyId) throw new Error('property_required'); return ctx.propertyId; };
  const userOf = (ctx) => (ctx && (ctx.userId || ctx.actorId)) || null;

  async function emit(type, aggregateType, aggregateId, payload, ctx) {
    if (!eventBus || !makeEvent || !ctx || !ctx.tenantId || !ctx.requestId) return;
    try { await eventBus.publish(makeEvent({ type, aggregateType, aggregateId: String(aggregateId), payload, ctx })); }
    catch (_) { /* events must not corrupt state */ }
  }
  async function audit(ctx, e) {
    await repo.appendAudit(Object.assign({ propertyId: ctx.propertyId, userId: userOf(ctx) }, e));
  }

  async function currentRoomStatus(propertyId, roomId) {
    const r = await repo.getRoomStatus(propertyId, roomId);
    return r ? r.status : ROOM_HK_STATUS.OCCUPIED;     // default: room starts occupied
  }

  async function advanceRoom(ctx, roomId, toStatus) {
    const propertyId = requireProperty(ctx);
    const from = await currentRoomStatus(propertyId, roomId);
    if (from === toStatus) return from;
    if (!canAdvance(from, toStatus)) throw new Error('invalid_hk_transition: ' + from + ' -> ' + toStatus);
    await repo.setRoomStatus(propertyId, roomId, toStatus);
    await audit(ctx, { roomId, action: 'ADVANCE', fromStatus: from, toStatus });
    await emit('housekeeping.status_changed', 'housekeeping', roomId, { room_id: roomId, from: from, to: toStatus, property_id: propertyId }, ctx);
    return toStatus;
  }

  async function getTaskOrThrow(propertyId, taskId) {
    const t = await repo.getTask(propertyId, taskId);
    if (!t) throw new Error('task_not_found');
    return t;
  }

  return {
    async createTask(ctx, { roomId, taskType, factors = {}, roomType = null, zone = null } = {}) {
      const propertyId = requireProperty(ctx);
      const prio = priority.score(factors);
      const est = readiness.predict({ taskType, roomType }, [], { now: now() }).estimatedMinutes;
      const task = makeTask({ propertyId, roomId, taskType, priority: prio, estimatedMinutes: est, zone, roomType });
      await repo.insertTask(task);
      await audit(ctx, { roomId, taskId: task.id, action: 'CREATE_TASK', toStatus: task.status });
      await emit('housekeeping.task_created', 'housekeeping', task.id,
        { task_id: task.id, room_id: roomId, task_type: taskType, priority: prio, property_id: propertyId }, ctx);
      // Cleaning tasks mark the room dirty (if it's still occupied/just vacated).
      if (CLEANING_TASKS.has(taskType)) {
        const from = await currentRoomStatus(propertyId, roomId);
        if (from === ROOM_HK_STATUS.OCCUPIED) await advanceRoom(ctx, roomId, ROOM_HK_STATUS.DIRTY);
      }
      return task;
    },

    async assignTask(ctx, { taskId, employeeId } = {}) {
      const propertyId = requireProperty(ctx);
      const t = await getTaskOrThrow(propertyId, taskId);
      if (![TASK_STATUS.PENDING, TASK_STATUS.ASSIGNED].includes(t.status)) throw new Error('invalid_task_transition: assign from ' + t.status);
      const updated = await repo.updateTask(propertyId, taskId, { status: TASK_STATUS.ASSIGNED, assignedTo: employeeId });
      await audit(ctx, { roomId: t.roomId, taskId, action: 'ASSIGN', toStatus: TASK_STATUS.ASSIGNED });
      await emit('housekeeping.task_assigned', 'housekeeping', taskId, { task_id: taskId, employee_id: employeeId, property_id: propertyId }, ctx);
      return updated;
    },

    async startTask(ctx, { taskId } = {}) {
      const propertyId = requireProperty(ctx);
      const t = await getTaskOrThrow(propertyId, taskId);
      if (![TASK_STATUS.PENDING, TASK_STATUS.ASSIGNED].includes(t.status)) throw new Error('invalid_task_transition: start from ' + t.status);
      const updated = await repo.updateTask(propertyId, taskId, { status: TASK_STATUS.IN_PROGRESS });
      if (CLEANING_TASKS.has(t.taskType)) await advanceRoom(ctx, t.roomId, ROOM_HK_STATUS.CLEANING);
      await audit(ctx, { roomId: t.roomId, taskId, action: 'START', toStatus: TASK_STATUS.IN_PROGRESS });
      return updated;
    },

    async completeTask(ctx, { taskId } = {}) {
      const propertyId = requireProperty(ctx);
      const t = await getTaskOrThrow(propertyId, taskId);
      if (t.status !== TASK_STATUS.IN_PROGRESS) throw new Error('invalid_task_transition: complete from ' + t.status);
      const updated = await repo.updateTask(propertyId, taskId, { status: TASK_STATUS.COMPLETED, completedAt: new Date(now()).toISOString() });
      if (CLEANING_TASKS.has(t.taskType)) await advanceRoom(ctx, t.roomId, ROOM_HK_STATUS.CLEAN);
      await audit(ctx, { roomId: t.roomId, taskId, action: 'COMPLETE', toStatus: TASK_STATUS.COMPLETED });
      await emit('housekeeping.task_completed', 'housekeeping', taskId, { task_id: taskId, room_id: t.roomId, property_id: propertyId }, ctx);
      return updated;
    },

    async inspectRoom(ctx, { roomId, passed = true } = {}) {
      const propertyId = requireProperty(ctx);
      if (passed) return advanceRoom(ctx, roomId, ROOM_HK_STATUS.INSPECTED);
      // Failed inspection -> rollback to CLEANING (audited).
      const from = await currentRoomStatus(propertyId, roomId);
      if (!isRollback(from, ROOM_HK_STATUS.CLEANING)) throw new Error('invalid_hk_rollback: ' + from + ' -> CLEANING');
      await repo.setRoomStatus(propertyId, roomId, ROOM_HK_STATUS.CLEANING);
      await audit(ctx, { roomId, action: 'ROLLBACK', fromStatus: from, toStatus: ROOM_HK_STATUS.CLEANING, reason: 'inspection_failed' });
      await emit('housekeeping.status_changed', 'housekeeping', roomId, { room_id: roomId, from, to: ROOM_HK_STATUS.CLEANING, rollback: true, property_id: propertyId }, ctx);
      return ROOM_HK_STATUS.CLEANING;
    },

    async markReady(ctx, { roomId } = {}) {
      const propertyId = requireProperty(ctx);
      const status = await advanceRoom(ctx, roomId, ROOM_HK_STATUS.READY);
      await emit('housekeeping.room_ready', 'housekeeping', roomId, { room_id: roomId, property_id: propertyId }, ctx);
      return status;
    },

    // queries
    async getTask(ctx, taskId) { return repo.getTask(requireProperty(ctx), taskId); },
    async listTasks(ctx, filter) { return repo.listTasks(requireProperty(ctx), filter || {}); },
    async getRoomStatus(ctx, roomId) { return currentRoomStatus(requireProperty(ctx), roomId); },
    async listAudit(ctx, filter) { return repo.listAudit(requireProperty(ctx), filter || {}); }
  };
}

module.exports = { buildHousekeepingTaskEngine };
