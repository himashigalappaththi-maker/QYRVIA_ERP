'use strict';

/**
 * legacyBridge (Phase 24 B8-A) - migrates a LIVE class-based mock adapter
 * (adapters/base/OTAAdapter contract: pushRates / pushInventory / pullBookings /
 * confirmBooking / cancelBooking / mapToCanonical) into the unified
 * CanonicalOTAAdapter contract.
 *
 * MOCK migration only: no real OTA connectivity is added. Behavior is delegated
 * to the existing mock methods, so the migration is behavior-preserving.
 */

const { NoopAuthStrategy } = require('./AuthStrategy');

function bridgeLegacyAdapter(legacy, { auth } = {}) {
  if (!legacy || !legacy.channel) throw new Error('bridgeLegacyAdapter: legacy adapter with channel required');
  return {
    channel: legacy.channel,
    auth: auth || new NoopAuthStrategy(),
    _legacy: legacy,

    async init() { /* mock: nothing to initialize */ },
    async health() { return { ok: true, detail: 'mock', channel: legacy.channel }; },
    async close() { /* mock: nothing to close */ },

    normalizeBooking(raw) { return legacy.mapToCanonical(raw); },

    async pushReservation(booking) {
      // Map outbound reservation intent onto the legacy confirm/cancel mocks.
      if (booking && booking.status === 'CANCELLED' && typeof legacy.cancelBooking === 'function') {
        await legacy.cancelBooking(booking.bookingId);
        return { ok: true, action: 'CANCELLED', mocked: true };
      }
      if (typeof legacy.confirmBooking === 'function') {
        await legacy.confirmBooking(booking && booking.bookingId);
        return { ok: true, action: 'CONFIRMED', mocked: true };
      }
      return { ok: true, mocked: true };
    },

    async pushAvailability(inv) { await legacy.pushInventory(inv); return { ok: true, mocked: true }; },
    async pushRateUpdate(rate)  { await legacy.pushRates(rate);    return { ok: true, mocked: true }; },

    handleWebhook(req) {
      // Mock inbound: accept raw bookings on the request and normalize them.
      const raw = (req && (req.bookings || req.payload)) || [];
      const list = Array.isArray(raw) ? raw : [raw];
      return { verified: true, events: list.map((r) => legacy.mapToCanonical(r)) };
    }
  };
}

module.exports = { bridgeLegacyAdapter };
