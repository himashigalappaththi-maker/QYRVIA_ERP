'use strict';

/**
 * Housekeeping Optimization models (Phase 15). Additive / self-contained;
 * JS / CommonJS. Deterministic - no AI/LLM.
 */

const crypto = require('crypto');

const TASK_TYPE = Object.freeze({
  CHECKOUT_CLEANING: 'CHECKOUT_CLEANING',
  STAYOVER_CLEANING: 'STAYOVER_CLEANING',
  DEEP_CLEANING: 'DEEP_CLEANING',
  INSPECTION: 'INSPECTION',
  MAINTENANCE_FOLLOWUP: 'MAINTENANCE_FOLLOWUP',
  VIP_PREPARATION: 'VIP_PREPARATION',
  TRANSFER_CLEANING: 'TRANSFER_CLEANING'
});

const TASK_STATUS = Object.freeze({
  PENDING: 'PENDING', ASSIGNED: 'ASSIGNED', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED'
});

// Room housekeeping lifecycle (distinct from the Phase 11 room.status; Phase 15
// owns this and never writes back to the Room engine).
const ROOM_HK_STATUS = Object.freeze({
  OCCUPIED: 'OCCUPIED', DIRTY: 'DIRTY', CLEANING: 'CLEANING', CLEAN: 'CLEAN', INSPECTED: 'INSPECTED', READY: 'READY'
});

// Forward transitions; rollback is a separate audited operation.
const ROOM_FLOW = Object.freeze({
  OCCUPIED: ['DIRTY'],
  DIRTY: ['CLEANING'],
  CLEANING: ['CLEAN'],
  CLEAN: ['INSPECTED'],
  INSPECTED: ['READY'],
  READY: []
});
const ROOM_ORDER = ['OCCUPIED', 'DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED', 'READY'];

// Baseline cleaning minutes by task type (refined by ReadinessPredictionEngine).
const BASE_MINUTES = Object.freeze({
  CHECKOUT_CLEANING: 30, STAYOVER_CLEANING: 20, DEEP_CLEANING: 60,
  INSPECTION: 10, MAINTENANCE_FOLLOWUP: 15, VIP_PREPARATION: 45, TRANSFER_CLEANING: 25
});

function canAdvance(from, to) { return !!ROOM_FLOW[from] && ROOM_FLOW[from].includes(to); }
function isRollback(from, to) { return ROOM_ORDER.indexOf(to) >= 0 && ROOM_ORDER.indexOf(to) < ROOM_ORDER.indexOf(from); }

function makeTask(f = {}) {
  if (!f.propertyId) throw new Error('Task: propertyId required');
  if (!f.roomId)     throw new Error('Task: roomId required');
  if (!TASK_TYPE[f.taskType]) throw new Error('Task: invalid taskType ' + JSON.stringify(f.taskType));
  return {
    id: f.id || crypto.randomUUID(),
    propertyId: String(f.propertyId),
    roomId: String(f.roomId),
    taskType: f.taskType,
    priority: f.priority != null ? Number(f.priority) : 0,
    status: f.status || TASK_STATUS.PENDING,
    assignedTo: f.assignedTo || null,
    estimatedMinutes: f.estimatedMinutes != null ? Number(f.estimatedMinutes) : (BASE_MINUTES[f.taskType] || 20),
    zone: f.zone || null,                // building|floor|wing|zone key for clustering
    roomType: f.roomType || null,
    createdAt: f.createdAt || new Date().toISOString(),
    completedAt: null
  };
}

module.exports = { TASK_TYPE, TASK_STATUS, ROOM_HK_STATUS, ROOM_FLOW, ROOM_ORDER, BASE_MINUTES, canAdvance, isRollback, makeTask };
