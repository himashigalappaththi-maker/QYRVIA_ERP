'use strict';

/**
 * channelSubscriber (Phase 24 S1 - event spine ONLY).
 *
 * Subscribes read-only to PMS reservation lifecycle events, normalizes each into
 * a single canonical structure, routes it to a deterministic channel action, and
 * LOGS the structured result. That is the entire job of S1.
 *
 * HARD ISOLATION (by construction):
 *   - No OTA adapter calls.        - No persistence / DB writes.
 *   - No PMS mutation.             - No external forwarding.
 *   - Does NOT mutate the source event or its payload.
 *
 * Mirrors the existing subscriber pattern (revenue/services/revenueSubscriber.js):
 * `eventBus.subscribe(type, handler)` returns an unsubscribe(); handlers are
 * wrapped so a throwing handler is isolated and never breaks the bus.
 */

const logger = require('../../config/logger');
const { route } = require('./channelEventRouter');
const { buildChannelMappingStore } = require('./channelMappingStore');
const { buildChannelSyncQueue } = require('./channelSyncQueue');

const SUBSCRIBED_EVENTS = Object.freeze([
  'reservation.created',
  'reservation.updated',
  'reservation.cancelled',
  'reservation.checked_in',
  'reservation.checked_out'
]);

// S2: deterministic event -> sync-state mapping (in-memory state machine only).
const STATE_MAP = Object.freeze({
  'reservation.created':     'CREATED',
  'reservation.updated':     'UPDATED',
  'reservation.cancelled':   'CANCELLED',
  'reservation.checked_in':  'CHECKED_IN',
  'reservation.checked_out': 'CHECKED_OUT'
});

/**
 * Normalize a raw PMS domain event into the canonical channel-spine shape.
 * PURE: reads from the event, returns a fresh object, mutates nothing.
 */
function normalize(event) {
  const p = (event && event.payload) || {};
  return {
    event:          event && event.event_type,
    reservation_id: p.reservation_id || p.id || (event && event.aggregate_id) || null,
    property_id:    (event && event.property_id) || p.property_id || null,
    guest_id:       p.guest_id || p.guestId || null,
    status:         p.status || null,
    timestamp:      (event && event.occurred_at) || null,
    source:         'pms'
  };
}

/**
 * Apply one canonical event to the in-memory mapping store (S2).
 * Pure state mutation only - no I/O, no OTA, no persistence.
 *   created   -> linkReservation + syncState CREATED
 *   updated   -> UPDATED
 *   cancelled -> CANCELLED
 *   checked_in/out -> CHECKED_IN / CHECKED_OUT
 */
function applyToStore(store, canonical, routed) {
  const rid = canonical && canonical.reservation_id;
  if (!rid) return null;
  const state = STATE_MAP[canonical.event];
  if (!state) return null;
  if (canonical.event === 'reservation.created') {
    store.linkReservation(rid, routed ? routed.channel : null);
  }
  store.updateSyncState(rid, state);
  return state;
}

/**
 * Enqueue the routed action onto the outbound sync queue (S3).
 * Pure hand-off: no OTA call, no network - just an in-memory enqueue.
 * Dedupe (reservation_id + action while PENDING) is enforced by the queue.
 */
function enqueueRouted(queue, canonical, routed) {
  if (!routed || !canonical || !canonical.reservation_id) return null;
  return queue.enqueue({
    reservation_id: canonical.reservation_id,
    action:         routed.action,
    channel:        routed.channel,
    payload:        canonical
  });
}

// Process-level idempotency guard: at most one live registration. A second
// build() with listeners already attached is a no-op that returns the existing
// unsubscribe - so a hot reload cannot stack duplicate listeners.
let _active = null;
// Default in-memory store used at boot when no store is injected.
let _defaultStore = null;
function getDefaultStore() {
  if (!_defaultStore) _defaultStore = buildChannelMappingStore();
  return _defaultStore;
}
// Default in-memory outbound queue used at boot when none is injected.
let _defaultQueue = null;
function getDefaultQueue() {
  if (!_defaultQueue) _defaultQueue = buildChannelSyncQueue();
  return _defaultQueue;
}

function buildChannelSubscriber({ eventBus, store, queue } = {}) {
  if (!eventBus) throw new Error('channelSubscriber: eventBus required');
  if (_active) return _active;
  const mapping = store || getDefaultStore();
  const syncQueue = queue || getDefaultQueue();

  const unsubs = SUBSCRIBED_EVENTS.map((type) => eventBus.subscribe(type, async (event) => {
    try {
      const canonical = normalize(event);              // pure
      const routed    = route(canonical);              // pure deterministic mapping
      const syncState = applyToStore(mapping, canonical, routed);   // S2: in-memory state
      const queued    = enqueueRouted(syncQueue, canonical, routed); // S3: in-memory enqueue
      const queuedLog = queued && queued.item ? { id: queued.item.id, status: queued.item.status } : queued;
      logger.info({ spine: 'pms->cm', canonical, routed, syncState, queued: queuedLog }, '[channelSubscriber] captured');
    } catch (err) {
      // Isolated: a handler error never propagates back into the bus fan-out.
      logger.error({ err, event_type: event && event.event_type }, '[channelSubscriber] handler error (isolated)');
    }
  }));

  const unsubscribe = () => {
    unsubs.forEach((u) => { try { u(); } catch (_) { /* ignore */ } });
    _active = null;
  };
  _active = unsubscribe;
  return unsubscribe;
}

module.exports = { buildChannelSubscriber, normalize, applyToStore, enqueueRouted, getDefaultStore, getDefaultQueue, SUBSCRIBED_EVENTS, STATE_MAP };
