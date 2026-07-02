'use strict';

/**
 * Availability engine (Phase 30.1) - pure + deterministic.
 *
 * available(date) = stopSell ? 0 : max(0, physical + overbookingBuffer - sold - blocked)
 *
 *   - physical : sellable units of the room type for the date
 *   - sold     : confirmed reservations consuming a unit
 *   - blocked  : maintenance / allotment / manual blocks
 *   - overbookingBuffer : configurable guard that ALLOWS selling N beyond physical
 *     (0 = no overbooking). Negative buffers are rejected at the model layer.
 *   - stopSell : hard close (overrides everything -> 0)
 *
 * No reservations DB lookup here: the engine computes over a normalized inventory
 * cell (the source of `sold`/`blocked` is the integration boundary, future phase).
 */

function availability(cell) {
  if (!cell) return { available: 0, stopSell: true, physical: 0, sold: 0, blocked: 0, overbookingBuffer: 0 };
  const { physical, sold, blocked, overbookingBuffer, stopSell } = cell;
  const available = stopSell ? 0 : Math.max(0, physical + overbookingBuffer - sold - blocked);
  return { available, stopSell: !!stopSell, physical, sold, blocked, overbookingBuffer };
}

/** True when at least one unit can be sold for the date. */
function isBookable(cell) { return availability(cell).available > 0; }

/**
 * Availability across a half-open stay [arrival, departure): the stay is sellable
 * only if EVERY night has >= 1 unit. Returns the limiting (minimum) availability.
 */
function stayAvailability(cellsByDate, arrival, departure) {
  let min = Infinity;
  for (let d = arrival; d < departure; d = nextDate(d)) {
    const a = availability(cellsByDate[d]).available;
    if (a < min) min = a;
  }
  return min === Infinity ? 0 : min;
}

function nextDate(date) {
  const t = Date.parse(date + 'T00:00:00Z') + 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

module.exports = { availability, isBookable, stayAvailability, nextDate };
