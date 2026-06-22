'use strict';

/**
 * HousekeepingSyncService - the housekeeping module's seam onto the Room &
 * Inventory Engine. It does not own room state; it drives the engine's
 * housekeeping-related transitions and lets the engine emit the events
 * (room.status_changed / room.cleaned). This keeps a single source of truth
 * for room status.
 */

function buildHousekeepingSyncService({ engine } = {}) {
  if (!engine) throw new Error('HousekeepingSyncService: engine required');
  return {
    /** Mark a room inspected (housekeeping sub-state; status unchanged). */
    async inspect(ctx, roomId) {
      return engine.inspect(ctx, { roomId });
    },
    /** Cleaning finished -> room returns to AVAILABLE (engine emits room.cleaned). */
    async complete(ctx, roomId) {
      return engine.cleaningComplete(ctx, { roomId });
    },
    /** Take a room out of service for maintenance / bring it back. */
    async setMaintenance(ctx, roomId) {
      return engine.setMaintenance(ctx, { roomId });
    },
    async clearMaintenance(ctx, roomId) {
      return engine.clearMaintenance(ctx, { roomId });
    }
  };
}

module.exports = { buildHousekeepingSyncService };
