'use strict';

/**
 * OTAAdapter - the strict contract every channel adapter must satisfy.
 *
 * The brief's TypeScript interface maps to this base class. All OTA-specific
 * logic lives behind this boundary; the core + services only ever see
 * canonical shapes.
 *
 *   pushRates(rate: CanonicalRate)       -> Promise<void>
 *   pushInventory(inv: CanonicalInventory)-> Promise<void>
 *   pullBookings()                        -> Promise<rawBooking[]>
 *   confirmBooking(id)                    -> Promise<void>
 *   cancelBooking(id)                     -> Promise<void>
 *   mapToCanonical(raw)                   -> CanonicalBooking
 *
 * Plus a `channel` property (one of canonical/types CHANNELS).
 */

const REQUIRED_METHODS = ['pushRates', 'pushInventory', 'pullBookings', 'confirmBooking', 'cancelBooking', 'mapToCanonical'];

class OTAAdapter {
  constructor(channel) {
    if (!channel) throw new Error('OTAAdapter: channel required');
    this.channel = channel;
  }
  async pushRates()    { throw new Error('not_implemented: pushRates'); }
  async pushInventory(){ throw new Error('not_implemented: pushInventory'); }
  async pullBookings() { throw new Error('not_implemented: pullBookings'); }
  async confirmBooking(){ throw new Error('not_implemented: confirmBooking'); }
  async cancelBooking(){ throw new Error('not_implemented: cancelBooking'); }
  mapToCanonical()     { throw new Error('not_implemented: mapToCanonical'); }
}

/**
 * Verify an object satisfies the adapter contract. Returns {ok, missing[]}.
 * Used by the adapter-contract test so every present + future OTA is checked.
 */
function assertImplements(adapter) {
  const missing = [];
  if (!adapter || !adapter.channel) missing.push('channel');
  for (const m of REQUIRED_METHODS) {
    if (!adapter || typeof adapter[m] !== 'function') missing.push(m);
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { OTAAdapter, assertImplements, REQUIRED_METHODS };
