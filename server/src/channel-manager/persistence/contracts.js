'use strict';

/**
 * Channel persistence contracts (Phase 24 B1).
 *
 * One method-set per store. Both the in-memory and DB implementations must
 * satisfy the same contract so the CHANNEL_PERSISTENCE flag can swap them with
 * zero caller change. `assertImplements` is used by the compliance tests.
 */

const CONTRACTS = Object.freeze({
  booking:    ['upsert', 'getById', 'getByExternalRef', 'setPmsReservationId', 'list', 'clear'],
  mapping:    ['upsertMapping', 'getMapping', 'linkReservation', 'getReservationLink', 'list', 'clear'],
  queue:      ['enqueue', 'dequeue', 'markProcessing', 'markCompleted', 'markFailed', 'get', 'list', 'size', 'clear'],
  deadLetter: ['insert', 'get', 'list', 'requestReprocess', 'clear'],
  syncState:  ['upsert', 'get', 'list', 'clear']
});

/** Returns { ok, missing[] } for a given store contract name + implementation. */
function assertImplements(storeName, impl) {
  const required = CONTRACTS[storeName];
  if (!required) return { ok: false, missing: ['<unknown contract: ' + storeName + '>'] };
  const missing = required.filter((m) => !impl || typeof impl[m] !== 'function');
  return { ok: missing.length === 0, missing };
}

module.exports = { CONTRACTS, assertImplements };
