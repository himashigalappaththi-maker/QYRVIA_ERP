'use strict';

/**
 * Reservation number generator.
 *
 * Format: PROPERTYCODE-YYYY-NNNNNN  (e.g. NEG-2026-000123)
 *
 * Uniqueness backed by reservation_counters (PRIMARY KEY = property_id+year)
 * + a SELECT FOR UPDATE on the counter row + INSERT-OR-UPDATE in one TX.
 * Repo callers MUST run this inside withTenant() so RLS sees the rows.
 *
 *   nextReservationNumber(repo, { tenantId, propertyId, propertyCode, year })
 *     -> { number: 'NEG-2026-000123', sequence: 123 }
 *
 * year defaults to UTC year if omitted.
 */

function _pad(n, width) {
  let s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

async function nextReservationNumber(repo, { tenantId, propertyId, propertyCode, year }) {
  if (!tenantId)     throw new Error('nextReservationNumber: tenantId required');
  if (!propertyId)   throw new Error('nextReservationNumber: propertyId required');
  if (!propertyCode) throw new Error('nextReservationNumber: propertyCode required');
  const y = Number.isInteger(year) ? year : new Date().getUTCFullYear();
  const seq = await repo.bumpReservationCounter({ tenantId, propertyId, year: y });
  return {
    number:  String(propertyCode).toUpperCase() + '-' + y + '-' + _pad(seq, 6),
    sequence: seq,
    year:    y
  };
}

module.exports = { nextReservationNumber };
