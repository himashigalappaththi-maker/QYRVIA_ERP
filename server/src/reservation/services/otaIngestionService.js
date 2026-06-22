'use strict';

/**
 * otaIngestionService - the retry-safe bridge from an OTA / Channel Manager
 * booking into a reservation.
 *
 * It consumes an OTA booking object (read-only; the Channel Manager is NOT
 * modified) and creates a reservation with a deterministic idempotencyKey
 * derived from the channel + the OTA's own booking reference. Re-delivering the
 * same OTA booking (a common OTA behavior) is therefore a no-op that returns
 * the existing reservation.
 */

function idempotencyKeyFor(booking) {
  const source = booking.source || booking.channel || 'ota';
  const ref = booking.externalRef || booking.bookingId || booking.id;
  if (!ref) throw new Error('ota booking missing reference');
  return 'ota:' + source + ':' + ref;
}

function buildOtaIngestionService({ reservationEngine } = {}) {
  if (!reservationEngine) throw new Error('otaIngestionService: reservationEngine required');

  return {
    idempotencyKeyFor,
    /** Map an OTA booking to a reservation request and create it idempotently. */
    async ingest(ctx, booking = {}) {
      const request = {
        source: booking.source || booking.channel || 'ota',
        guestId: booking.guestId || null,
        checkInDate: booking.checkInDate || booking.arrival,
        checkOutDate: booking.checkOutDate || booking.departure,
        roomCategoryId: booking.roomCategoryId || booking.categoryId,
        guests: booking.guests || { adults: 1, children: 0 },
        pricing: booking.pricing || {},
        idempotencyKey: booking.idempotencyKey || idempotencyKeyFor(booking)
      };
      return reservationEngine.createReservation(ctx, request);
    }
  };
}

module.exports = { buildOtaIngestionService, idempotencyKeyFor };
