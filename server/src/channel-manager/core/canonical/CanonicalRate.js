'use strict';

/**
 * CanonicalRate - normalized rate push payload.
 * Identity = (propertyId, roomTypeId, ratePlanId, date).
 */

function makeCanonicalRate(fields = {}) {
  const f = fields || {};
  if (!f.propertyId)  throw new Error('CanonicalRate: propertyId required');
  if (!f.roomTypeId)  throw new Error('CanonicalRate: roomTypeId required');
  if (!f.date)        throw new Error('CanonicalRate: date required (YYYY-MM-DD)');
  if (f.amount == null || !(Number(f.amount) >= 0)) throw new Error('CanonicalRate: amount must be >= 0');

  return Object.freeze({
    propertyId: f.propertyId,
    roomTypeId: f.roomTypeId,
    ratePlanId: f.ratePlanId || 'STD',
    date:       f.date,
    amount:     Number(f.amount),
    currency:   f.currency || 'LKR'
  });
}

/** Identity key used for delta-sync dedupe + idempotency. */
function rateKey(r) {
  return ['rate', r.propertyId, r.roomTypeId, r.ratePlanId, r.date].join(':');
}

module.exports = { makeCanonicalRate, rateKey };
