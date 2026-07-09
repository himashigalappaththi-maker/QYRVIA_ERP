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

// First-class channels. QYRVIA_CONNECT is the canonical code for QYRVIA Connect —
// a QYRVIA-owned B2B OTA/distribution platform. Zero commission. No external
// certification required (QYRVIA-owned). Uses in-process transport.
// Phase 49: MAKEMYTRIP, GOOGLE, TRIPADVISOR added (stub adapters, not_configured).
// Phase 51: QTCN kept as legacy alias for backward compat (old queued jobs/env/DB rows).
const CHANNELS = Object.freeze({
  BOOKING_COM:     'BOOKING_COM',
  AGODA:           'AGODA',
  EXPEDIA:         'EXPEDIA',
  AIRBNB:          'AIRBNB',
  MAKEMYTRIP:      'MAKEMYTRIP',
  GOOGLE:          'GOOGLE',
  TRIPADVISOR:     'TRIPADVISOR',
  QYRVIA_CONNECT:  'QYRVIA_CONNECT',
  QTCN:            'QTCN'             // legacy alias — do not use in new code
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
