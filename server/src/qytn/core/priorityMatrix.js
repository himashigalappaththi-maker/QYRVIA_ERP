'use strict';

/**
 * QTCN priority matrix - the channel universe + per-channel economics.
 *
 * This is CONFIG, not code: adding a new OTA to QTCN's consideration set is a
 * single entry here (and, for execution, a single new adapter file in the
 * Channel Manager). No engine/core change, no sync-engine change.
 *
 *   commissionPct   - what the channel takes (QTCN = 0, direct revenue)
 *   strictness      - cancellation-policy strictness 0..1 (higher = stricter)
 *   direct          - true for the internal direct path (QTCN)
 *   enabled         - toggle without deleting the entry
 */

const CHANNELS = Object.freeze({
  QTCN:           { commissionPct: 0,  strictness: 0.5, direct: true,  enabled: true },
  'booking.com':  { commissionPct: 15, strictness: 0.70, direct: false, enabled: true },
  agoda:          { commissionPct: 18, strictness: 0.60, direct: false, enabled: true },
  expedia:        { commissionPct: 20, strictness: 0.65, direct: false, enabled: true },
  airbnb:         { commissionPct: 14, strictness: 0.50, direct: false, enabled: true },
  makemytrip:     { commissionPct: 16, strictness: 0.55, direct: false, enabled: true },
  'google.travel':{ commissionPct: 12, strictness: 0.40, direct: false, enabled: true },
  tripadvisor:    { commissionPct: 17, strictness: 0.45, direct: false, enabled: true }
});

const DIRECT_CHANNEL = 'QTCN';

const THRESHOLDS = Object.freeze({
  commissionDirectPct: 18,   // OTA commission strictly above this -> prefer direct
  inventoryMismatch:   0.5,  // mismatch risk above this -> fallback to direct
  highCancellation:    0.6   // cancellation risk above this -> prefer strict OTA
});

function getChannel(name) { return CHANNELS[name] || null; }

/** OTA channels (excludes the direct channel), enabled only. */
function listOtas() {
  return Object.keys(CHANNELS).filter((c) => c !== DIRECT_CHANNEL && CHANNELS[c].enabled);
}

module.exports = { CHANNELS, DIRECT_CHANNEL, THRESHOLDS, getChannel, listOtas };
