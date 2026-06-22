'use strict';

/**
 * AvailabilityCalculator - pure, deterministic availability logic.
 *
 * A room is AVAILABLE for a date range iff:
 *   - it is NOT OCCUPIED, and
 *   - it is NOT under MAINTENANCE, and
 *   - it is NOT blocked by an overlapping reservation in that date range.
 *
 * Dates are 'YYYY-MM-DD' strings; ranges are half-open [dateFrom, dateTo).
 */

const { STATUS } = require('../rooms/RoomModel');

function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && aTo > bFrom;
}

function isBlocked(roomId, blocks, range) {
  if (!range || !range.dateFrom || !range.dateTo) return false;
  return (blocks || []).some((b) =>
    b.roomId === roomId && rangesOverlap(range.dateFrom, range.dateTo, b.dateFrom, b.dateTo));
}

function isAvailable(room, blocks, range) {
  if (!room) return false;
  if (room.status === STATUS.OCCUPIED) return false;
  if (room.status === STATUS.MAINTENANCE) return false;
  if (isBlocked(room.roomId, blocks, range)) return false;
  return true;
}

function availableRooms(rooms, blocks, range) {
  return (rooms || []).filter((r) => isAvailable(r, blocks, range));
}

module.exports = { rangesOverlap, isBlocked, isAvailable, availableRooms };
