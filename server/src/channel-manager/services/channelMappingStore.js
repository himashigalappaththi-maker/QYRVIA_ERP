'use strict';

/**
 * channelMappingStore (Phase 24 S2) - PURE in-memory mapping + sync-state layer.
 *
 * Tracks reservation -> channel relationships and per-reservation sync state.
 * "Pure" here means: no I/O, no network, no OTA, no DB - a deterministic
 * state machine whose only state is its own Maps. Given the same calls (and the
 * same injected clock) it yields the same results, so it is fully testable.
 *
 * HARD ISOLATION: in-memory only. Nothing in this file imports an adapter, a
 * repo, a DB facade, or the network.
 */

const SYNC_STATES = Object.freeze(['CREATED', 'UPDATED', 'CANCELLED', 'CHECKED_IN', 'CHECKED_OUT']);

function buildChannelMappingStore({ clock = () => Date.now() } = {}) {
  const reservationToChannel    = new Map();
  const reservationToExternalId = new Map();
  const lastSync                = new Map();
  const syncState               = new Map();

  function linkReservation(reservation_id, channel) {
    if (!reservation_id) return false;
    reservationToChannel.set(reservation_id, channel != null ? channel : null);
    return true;
  }

  function setExternalId(reservation_id, external_id) {
    if (!reservation_id) return false;
    reservationToExternalId.set(reservation_id, external_id != null ? external_id : null);
    return true;
  }

  function getChannel(reservation_id) {
    return reservationToChannel.has(reservation_id) ? reservationToChannel.get(reservation_id) : null;
  }

  function getExternalId(reservation_id) {
    return reservationToExternalId.has(reservation_id) ? reservationToExternalId.get(reservation_id) : null;
  }

  function updateSyncState(reservation_id, state) {
    if (!reservation_id || !state) return false;
    syncState.set(reservation_id, state);
    lastSync.set(reservation_id, clock());
    return true;
  }

  function getSyncState(reservation_id) {
    return syncState.has(reservation_id) ? syncState.get(reservation_id) : null;
  }

  function getLastSync(reservation_id) {
    return lastSync.has(reservation_id) ? lastSync.get(reservation_id) : null;
  }

  /** Read-only view of one reservation's mapping (handy for tests / future projection). */
  function snapshot(reservation_id) {
    return {
      reservation_id,
      channel:     getChannel(reservation_id),
      external_id: getExternalId(reservation_id),
      sync_state:  getSyncState(reservation_id),
      last_sync:   getLastSync(reservation_id)
    };
  }

  function size() { return syncState.size; }

  function clear() {
    reservationToChannel.clear();
    reservationToExternalId.clear();
    lastSync.clear();
    syncState.clear();
  }

  return {
    linkReservation, setExternalId,
    getChannel, getExternalId,
    updateSyncState, getSyncState, getLastSync,
    snapshot, size, clear
  };
}

module.exports = { buildChannelMappingStore, SYNC_STATES };
