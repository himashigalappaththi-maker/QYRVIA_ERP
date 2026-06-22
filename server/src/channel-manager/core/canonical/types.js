'use strict';

/**
 * Channel Manager canonical types (Phase 10.0).
 *
 * The canonical model is the ONLY vocabulary the core + services speak. OTA
 * adapters translate raw vendor payloads into these shapes (and back). No
 * OTA-specific field ever leaks past an adapter boundary.
 *
 * Plain JS / CommonJS to match the rest of the backend (no TypeScript
 * toolchain). The brief's `.ts` filenames map 1:1 onto these `.js` modules.
 */

// First-class channels. QTCN is QYRVIA's own internal, zero-commission
// distribution engine - it behaves like an OTA adapter but is first-class.
const CHANNELS = Object.freeze({
  BOOKING_COM: 'BOOKING_COM',
  AGODA: 'AGODA',
  EXPEDIA: 'EXPEDIA',
  AIRBNB: 'AIRBNB',
  QTCN: 'QTCN'
});

const BOOKING_STATUS = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW'
});

const RESOURCE = Object.freeze({
  RATE: 'RATE',
  INVENTORY: 'INVENTORY',
  BOOKING: 'BOOKING'
});

function isChannel(c) { return Object.prototype.hasOwnProperty.call(CHANNELS, c); }
function isBookingStatus(s) { return Object.prototype.hasOwnProperty.call(BOOKING_STATUS, s); }

module.exports = { CHANNELS, BOOKING_STATUS, RESOURCE, isChannel, isBookingStatus };
