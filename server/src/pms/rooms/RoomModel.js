'use strict';

/**
 * Canonical Room model (PMS Phase 11 - Room & Inventory Engine).
 *
 * This is the truth layer for physical hotel capacity. Self-contained and
 * additive: it does NOT alter the Phase 5 `rooms` table / `room_status` enum
 * or any existing PMS code. JS / CommonJS.
 *
 * Room shape:
 *   { roomId, propertyId, categoryId, floorId, roomNumber,
 *     status, housekeepingState, currentReservationId, lastUpdated }
 */

const STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  OCCUPIED: 'OCCUPIED',
  CLEANING: 'CLEANING',
  MAINTENANCE: 'MAINTENANCE'
});

const HOUSEKEEPING = Object.freeze({
  CLEAN: 'CLEAN',
  DIRTY: 'DIRTY',
  INSPECTED: 'INSPECTED'
});

function isStatus(s) { return Object.prototype.hasOwnProperty.call(STATUS, s); }

function makeRoom(fields = {}) {
  const f = fields || {};
  if (!f.roomId)     throw new Error('Room: roomId required');
  if (!f.propertyId) throw new Error('Room: propertyId required');
  if (!f.categoryId) throw new Error('Room: categoryId required');
  if (!f.floorId)    throw new Error('Room: floorId required');
  if (!f.roomNumber) throw new Error('Room: roomNumber required');
  const status = f.status || STATUS.AVAILABLE;
  if (!isStatus(status)) throw new Error('Room: invalid status ' + JSON.stringify(status));

  return {
    roomId: String(f.roomId),
    propertyId: String(f.propertyId),
    categoryId: String(f.categoryId),
    floorId: String(f.floorId),
    roomNumber: String(f.roomNumber),
    status,
    housekeepingState: f.housekeepingState || HOUSEKEEPING.CLEAN,
    currentReservationId: f.currentReservationId || null,
    lastUpdated: f.lastUpdated || new Date().toISOString()
  };
}

module.exports = { STATUS, HOUSEKEEPING, isStatus, makeRoom };
