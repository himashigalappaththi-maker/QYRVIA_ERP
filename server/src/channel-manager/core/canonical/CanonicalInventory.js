'use strict';

/**
 * CanonicalInventory - normalized availability push payload.
 * Identity = (propertyId, roomTypeId, date).
 */

function makeCanonicalInventory(fields = {}) {
  const f = fields || {};
  if (!f.propertyId) throw new Error('CanonicalInventory: propertyId required');
  if (!f.roomTypeId) throw new Error('CanonicalInventory: roomTypeId required');
  if (!f.date)       throw new Error('CanonicalInventory: date required (YYYY-MM-DD)');
  const avail = Number(f.available);
  if (!Number.isInteger(avail) || avail < 0) throw new Error('CanonicalInventory: available must be a non-negative integer');

  return Object.freeze({
    propertyId: f.propertyId,
    roomTypeId: f.roomTypeId,
    date:       f.date,
    available:  avail,
    stopSell:   !!f.stopSell,
    minLos:     f.minLos != null ? Number(f.minLos) : null,
    maxLos:     f.maxLos != null ? Number(f.maxLos) : null
  });
}

function inventoryKey(i) {
  return ['inv', i.propertyId, i.roomTypeId, i.date].join(':');
}

module.exports = { makeCanonicalInventory, inventoryKey };
