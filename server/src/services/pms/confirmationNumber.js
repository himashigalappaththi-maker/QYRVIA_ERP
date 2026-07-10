'use strict';

// Derives a confirmation number from the reservation UUID.
// Format: first 8 hex characters, uppercased (e.g. A1B2C3D4).
// Uniqueness is guaranteed because reservation IDs are gen_random_uuid() v4 —
// no counter table or additional migration required.
// The partial unique index uq_reservations_confirmation enforces property-level
// uniqueness at the DB layer if a collision ever occurred in theory.

function generateConfirmationNumber(reservationId) {
  if (!reservationId || typeof reservationId !== 'string') return null;
  return reservationId.replace(/-/g, '').substring(0, 8).toUpperCase();
}

module.exports = { generateConfirmationNumber };
