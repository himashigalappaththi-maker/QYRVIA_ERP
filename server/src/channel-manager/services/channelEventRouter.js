'use strict';

/**
 * channelEventRouter (Phase 24 S1) - PURE, deterministic mapping from a PMS
 * domain event to a channel action. No side effects: no I/O, no OTA, no DB.
 *
 * S1 scope: there is no channel_mapping_store yet (DB writes are forbidden in
 * this step), so the route target is a single logical destination - the Channel
 * Manager core. Per-OTA fan-out (one routed action per mapped channel) arrives
 * with the mapping store in a later step; this function's signature is shaped to
 * absorb that change without callers breaking.
 */

const EVENT_ACTION_MAP = Object.freeze({
  'reservation.created':     'CREATE_BOOKING',
  'reservation.updated':     'UPDATE_BOOKING',
  'reservation.cancelled':   'CANCEL_BOOKING',
  'reservation.checked_in':  'CHECK_IN',
  'reservation.checked_out': 'CHECK_OUT'
});

const ROUTE_TARGET = 'channel-manager';

/** eventType -> action | null (unknown types map to null, never throw). */
function actionFor(eventType) {
  return EVENT_ACTION_MAP[eventType] || null;
}

/**
 * route(canonical) -> { channel, action, payload } | null
 * Pure: returns a fresh object; never mutates `canonical`.
 */
function route(canonical) {
  if (!canonical || !canonical.event) return null;
  const action = actionFor(canonical.event);
  if (!action) return null;
  return { channel: ROUTE_TARGET, action, payload: canonical };
}

module.exports = { route, actionFor, EVENT_ACTION_MAP, ROUTE_TARGET };
