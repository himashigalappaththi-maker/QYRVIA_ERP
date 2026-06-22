'use strict';

/**
 * In-memory room store (default backing for the Room & Inventory Engine).
 *
 * Defines the store interface the engine depends on. A pg-backed store
 * implementing the same four methods can be dropped in for production
 * persistence (additive `room_inventory` table) without touching the engine.
 *
 * Every method is property-scoped: there is no way to read or mutate a room
 * without the owning propertyId (multi-property isolation at the store seam).
 */

function buildMemoryRoomStore() {
  // key = propertyId + '|' + roomId
  const rooms = new Map();
  const key = (propertyId, roomId) => propertyId + '|' + roomId;

  return {
    async insert(room) {
      const k = key(room.propertyId, room.roomId);
      if (rooms.has(k)) { const e = new Error('duplicate_room'); e.code = 'DUP'; throw e; }
      rooms.set(k, Object.assign({}, room));
      return Object.assign({}, room);
    },
    async get(propertyId, roomId) {
      const r = rooms.get(key(propertyId, roomId));
      return r ? Object.assign({}, r) : null;
    },
    async list(propertyId, filter = {}) {
      const out = [];
      for (const r of rooms.values()) {
        if (r.propertyId !== propertyId) continue;            // isolation
        if (filter.status && r.status !== filter.status) continue;
        if (filter.categoryId && r.categoryId !== filter.categoryId) continue;
        if (filter.floorId && r.floorId !== filter.floorId) continue;
        out.push(Object.assign({}, r));
      }
      return out;
    },
    async update(propertyId, roomId, patch) {
      const k = key(propertyId, roomId);
      const r = rooms.get(k);
      if (!r || r.propertyId !== propertyId) return null;     // isolation
      Object.assign(r, patch, { lastUpdated: new Date().toISOString() });
      return Object.assign({}, r);
    }
  };
}

module.exports = { buildMemoryRoomStore };
