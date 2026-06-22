'use strict';

/**
 * Availability engine.
 *
 *   roomsByDate(repo, { tenantId, propertyId, date, roomTypeId? })
 *     -> { roomType: { total, occupied, available, rooms: [{id, room_number, status}] } }
 *
 *   inventoryByRange(repo, { tenantId, propertyId, dateFrom, dateTo, roomTypeId? })
 *     -> { rangeStart, rangeEnd, days: [{ date, roomTypes: { [rtCode]: { total, sold, available } } }] }
 *
 *   calendar(repo, ...) - alias of inventoryByRange returning a calendar-shape array
 *
 * Rules (Phase 5):
 *   - reservations with status CONFIRMED or OPTION reduce inventory across
 *     [arrival_date, departure_date) (departure day is checkout, not consumed)
 *   - cancellations restore inventory automatically (CANCELLED/NO_SHOW excluded)
 *   - no overbooking logic, no channel-manager logic
 *
 * No fake data. If repo returns 0 rooms, the engine reports 0 across the
 * board - it does not invent inventory.
 */

const HOLD_STATUSES = ['CONFIRMED', 'OPTION'];

function _addDays(dateIso, n) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function _diffDays(fromIso, toIso) {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso   + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

async function roomsByDate(repo, { tenantId, propertyId, date, roomTypeId }) {
  if (!tenantId || !propertyId || !date) throw new Error('roomsByDate: tenantId+propertyId+date required');
  const rooms = await repo.listRoomsForAvailability({ tenantId, propertyId, roomTypeId });
  const reservations = await repo.listReservationsOverlapping({
    tenantId, propertyId, date, statuses: HOLD_STATUSES, roomTypeId
  });
  // Group by room_type
  const byType = {};
  for (const r of rooms) {
    if (!r.active) continue;
    const key = r.room_type_id;
    if (!byType[key]) byType[key] = {
      room_type_id: key, room_type_code: r.room_type_code,
      total: 0, occupied: 0, available: 0, rooms: []
    };
    byType[key].total++;
    byType[key].rooms.push({ id: r.id, room_number: r.room_number, status: r.status });
  }
  // Apply reservation hold counts
  for (const res of reservations) {
    const slot = byType[res.room_type_id];
    if (!slot) continue;
    slot.occupied += res.rooms_count || 1;
  }
  for (const k of Object.keys(byType)) {
    byType[k].available = Math.max(0, byType[k].total - byType[k].occupied);
  }
  return byType;
}

async function inventoryByRange(repo, { tenantId, propertyId, dateFrom, dateTo, roomTypeId }) {
  if (!tenantId || !propertyId || !dateFrom || !dateTo) throw new Error('inventoryByRange: required fields missing');
  const days = _diffDays(dateFrom, dateTo);
  if (days < 0 || days > 366) throw new Error('inventoryByRange: range invalid or too wide');

  // Pull rooms once (inventory doesn't vary day-by-day in Phase 5)
  const rooms = await repo.listRoomsForAvailability({ tenantId, propertyId, roomTypeId });
  const reservations = await repo.listReservationsInRange({
    tenantId, propertyId, dateFrom, dateTo, statuses: HOLD_STATUSES, roomTypeId
  });

  // Inventory by room-type code
  const totalByType = {};
  for (const r of rooms) {
    if (!r.active) continue;
    const code = r.room_type_code;
    totalByType[code] = (totalByType[code] || 0) + 1;
  }

  const out = [];
  for (let i = 0; i < days; i++) {
    const date = _addDays(dateFrom, i);
    const roomTypes = {};
    for (const code of Object.keys(totalByType)) {
      roomTypes[code] = { total: totalByType[code], sold: 0, available: totalByType[code] };
    }
    for (const res of reservations) {
      const occupies = (date >= res.arrival_date) && (date < res.departure_date);
      if (!occupies) continue;
      const code = res.room_type_code;
      if (!roomTypes[code]) continue;
      roomTypes[code].sold += res.rooms_count || 1;
      roomTypes[code].available = Math.max(0, roomTypes[code].total - roomTypes[code].sold);
    }
    out.push({ date, roomTypes });
  }
  return { rangeStart: dateFrom, rangeEnd: dateTo, days: out };
}

const calendar = inventoryByRange;

module.exports = { roomsByDate, inventoryByRange, calendar, HOLD_STATUSES };
