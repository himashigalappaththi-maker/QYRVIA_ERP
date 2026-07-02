'use strict';

/**
 * CanonicalOTAAdapter (Phase 24 B8-A) - the SINGLE unified OTA adapter contract.
 *
 * Supersedes the two prior contracts:
 *   - adapters/base/OTAAdapter.js  (6-method: pushRates/pushInventory/pullBookings/
 *     confirmBooking/cancelBooking/mapToCanonical) - LIVE, now bridged into this.
 *   - adapters/base/assertAdapter.js (5-method Phase 10.2) - DEPRECATED.
 *
 * Required surface (data plane + lifecycle):
 *   init()             -> Promise<void>     wire AuthStrategy, validate readiness
 *   health()           -> Promise<{ok}>     gate routing; degraded => park jobs
 *   close()            -> Promise<void>
 *   normalizeBooking(raw) -> CanonicalBooking
 *   pushReservation(booking)   -> Promise<ack>
 *   pushAvailability(inv)      -> Promise<ack>
 *   pushRateUpdate(rate)       -> Promise<ack>
 *   handleWebhook(req) -> { verified, events: CanonicalBooking[] }
 *
 * Plus a `channel` identity and an `auth` AuthStrategy (never raw secrets).
 */

const CANONICAL_METHODS = Object.freeze([
  'init', 'health', 'close',
  'normalizeBooking', 'pushReservation', 'pushAvailability', 'pushRateUpdate', 'handleWebhook'
]);

class CanonicalOTAAdapter {
  constructor({ channel, auth } = {}) {
    if (!channel) throw new Error('CanonicalOTAAdapter: channel required');
    this.channel = channel;
    this.auth = auth || null; // AuthStrategy; holds only a credentials_ref, never a secret
  }

  async init() { /* default no-op */ }
  async health() { return { ok: true }; }
  async close() { /* default no-op */ }

  normalizeBooking() { throw new Error('not_implemented: normalizeBooking'); }
  async pushReservation() { throw new Error('not_implemented: pushReservation'); }
  async pushAvailability() { throw new Error('not_implemented: pushAvailability'); }
  async pushRateUpdate() { throw new Error('not_implemented: pushRateUpdate'); }
  handleWebhook() { throw new Error('not_implemented: handleWebhook'); }
}

module.exports = { CanonicalOTAAdapter, CANONICAL_METHODS };
