'use strict';

/**
 * OccupancyTracker - pure occupancy statistics over a set of rooms.
 */

const { STATUS } = require('../rooms/RoomModel');

function snapshot(rooms = []) {
  const counts = { total: rooms.length, AVAILABLE: 0, OCCUPIED: 0, CLEANING: 0, MAINTENANCE: 0 };
  for (const r of rooms) {
    if (counts[r.status] != null) counts[r.status] += 1;
  }
  const occupancyPct = counts.total > 0
    ? Math.round((counts[STATUS.OCCUPIED] / counts.total) * 10000) / 100
    : 0;
  return {
    total: counts.total,
    available: counts.AVAILABLE,
    occupied: counts.OCCUPIED,
    cleaning: counts.CLEANING,
    maintenance: counts.MAINTENANCE,
    occupancyPct
  };
}

module.exports = { snapshot };
