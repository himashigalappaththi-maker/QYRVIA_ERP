'use strict';

/**
 * In-memory housekeeping repository (default backing). Property-scoped; owns
 * tasks, room housekeeping status, and the audit log (propertyId, userId,
 * timestamp on every transition).
 */

function buildMemoryHousekeepingRepo() {
  const tasks = new Map();          // propertyId|taskId -> task
  const roomStatus = new Map();     // propertyId|roomId -> { status, updatedAt }
  const audit = [];                 // audit log
  const k = (p, id) => p + '|' + id;

  return {
    async insertTask(task) { tasks.set(k(task.propertyId, task.id), Object.assign({}, task)); return Object.assign({}, task); },
    async getTask(propertyId, taskId) { const t = tasks.get(k(propertyId, taskId)); return t ? Object.assign({}, t) : null; },
    async updateTask(propertyId, taskId, patch) {
      const t = tasks.get(k(propertyId, taskId));
      if (!t || t.propertyId !== propertyId) return null;
      Object.assign(t, patch);
      return Object.assign({}, t);
    },
    async listTasks(propertyId, filter = {}) {
      const out = [];
      for (const t of tasks.values()) {
        if (t.propertyId !== propertyId) continue;
        if (filter.status && t.status !== filter.status) continue;
        if (filter.assignedTo && t.assignedTo !== filter.assignedTo) continue;
        out.push(Object.assign({}, t));
      }
      return out;
    },

    async getRoomStatus(propertyId, roomId) {
      const r = roomStatus.get(k(propertyId, roomId));
      return r ? Object.assign({}, r) : null;
    },
    async setRoomStatus(propertyId, roomId, status) {
      const rec = { propertyId, roomId, status, updatedAt: new Date().toISOString() };
      roomStatus.set(k(propertyId, roomId), rec);
      return Object.assign({}, rec);
    },
    async listRoomStatuses(propertyId) {
      const out = [];
      for (const r of roomStatus.values()) if (r.propertyId === propertyId) out.push(Object.assign({}, r));
      return out;
    },

    async appendAudit(entry) {
      audit.push(Object.assign({ at: new Date().toISOString() }, entry));
    },
    async listAudit(propertyId, filter = {}) {
      return audit.filter((a) => a.propertyId === propertyId
        && (!filter.roomId || a.roomId === filter.roomId)
        && (!filter.taskId || a.taskId === filter.taskId));
    },
    _audit: audit
  };
}

module.exports = { buildMemoryHousekeepingRepo };
