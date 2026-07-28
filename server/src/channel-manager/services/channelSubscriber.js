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
const { routeAll } = require('./channelEventRouter');
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
    // ---- PHASE 65 C2: TRUSTED IDENTITY ---------------------------------
    // These fields were dropped entirely, even though the source domain event
    // carries every one of them (see src/core/event.js). The consequences were
    // concrete: realProcessor rejects a job with no tenant_id as
    // `tenant_required`, the dead-letter store recorded `tenant_id: 'unknown'`,
    // and against the DB-backed queue the enqueue THROWS because the column is
    // NOT NULL REFERENCES tenants(id).
    //
    // tenant_id and property_id are read ONLY from the event envelope — the
    // trusted domain-event context stamped by the command bus — never from
    // `event.payload`, which is command input and therefore attacker-influenced.
    tenant_id:      (event && event.tenant_id) || null,
    property_id:    (event && event.property_id) || null,
    actor_id:       (event && event.actor_id) || null,
    request_id:     (event && event.request_id) || null,
    event_id:       (event && event.event_id) || null,
    event_type:     (event && event.event_type) || null,
    aggregate_type: (event && event.aggregate_type) || null,
    aggregate_id:   (event && event.aggregate_id) || null,
    occurred_at:    (event && event.occurred_at) || null,

    // ---- existing canonical spine shape (unchanged) --------------------
    event:          event && event.event_type,
    reservation_id: p.reservation_id || p.id || (event && event.aggregate_id) || null,
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
 * Enqueue ONE routed action onto the outbound sync queue.
 *
 * PHASE 65 C2 — FAIL CLOSED ON MISSING IDENTITY.
 * A job with no tenant is unusable: the queue table's tenant_id is
 * NOT NULL REFERENCES tenants(id), the processor rejects it, and the
 * dead-letter row used to be written with the literal string 'unknown', which
 * is worse than no row at all — it looks like data. We refuse before insertion
 * and say why, with stable machine codes.
 */
function enqueueRouted(queue, canonical, routed) {
  if (!routed || !canonical || !canonical.reservation_id) return null;

  if (!canonical.tenant_id) {
    return { accepted: false, reason: 'tenant_required' };
  }
  if (!canonical.property_id) {
    return { accepted: false, reason: 'property_required' };
  }
  if (!routed.channel) {
    return { accepted: false, reason: 'channel_identity_invalid' };
  }

  return queue.enqueue({
    tenant_id:      canonical.tenant_id,
    property_id:    canonical.property_id,
    actor_id:       canonical.actor_id || null,
    request_id:     canonical.request_id || null,
    event_id:       canonical.event_id || null,
    event_type:     canonical.event_type || canonical.event || null,
    aggregate_type: canonical.aggregate_type || null,
    aggregate_id:   canonical.aggregate_id || null,
    occurred_at:    canonical.occurred_at || null,
    reservation_id: canonical.reservation_id,
    action:         routed.action,
    channel:        routed.channel,
    payload:        canonical
  });
}

/**
 * Fan one canonical event out to every ENABLED mapped channel and enqueue one
 * job per channel.
 *
 * PHASE 65 C1/C2 — the registry lookup lives here, not in the pure router.
 *
 * FAIL CLOSED, three ways:
 *   - no resolver wired          -> enqueue NOTHING and say so loudly. The old
 *                                   behaviour enqueued one job stamped
 *                                   'channel-manager', which no provider can
 *                                   resolve; a bogus job is worse than none.
 *   - resolver throws / rejects  -> enqueue NOTHING. A registry we cannot read
 *                                   is not permission to broadcast.
 *   - unknown channel code       -> channel_identity_invalid, nothing enqueued.
 *
 * @returns {{ok:boolean, reason?:string, enqueued:Array, channels:Array<string>}}
 */
async function fanOutAndEnqueue(queue, canonical, resolveChannels) {
  if (typeof resolveChannels !== 'function') {
    return { ok: false, reason: 'channel_registry_unavailable', enqueued: [], channels: [] };
  }

  let mappings;
  try {
    mappings = await resolveChannels({
      tenantId:   canonical.tenant_id,
      propertyId: canonical.property_id,
      eventType:  canonical.event
    });
  } catch (err) {
    return {
      ok: false, reason: 'channel_registry_unavailable',
      detail: String((err && err.message) || err), enqueued: [], channels: []
    };
  }
  if (!Array.isArray(mappings)) {
    return { ok: false, reason: 'channel_registry_unavailable', enqueued: [], channels: [] };
  }

  let jobs;
  try {
    jobs = routeAll(canonical, mappings);
  } catch (err) {
    return {
      ok: false, reason: (err && err.code) || 'channel_identity_invalid',
      detail: String((err && err.message) || err), enqueued: [], channels: []
    };
  }

  const enqueued = [];
  for (const job of jobs) {
    const res = await Promise.resolve(enqueueRouted(queue, canonical, job));
    enqueued.push({ channel: job.channel, action: job.action, result: res });
  }
  return { ok: true, enqueued, channels: jobs.map((j) => j.channel) };
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

/**
 * @param {object}   deps
 * @param {object}   deps.eventBus
 * @param {object}  [deps.store]            in-memory mapping store
 * @param {object}  [deps.queue]            outbound sync queue
 * @param {Function}[deps.resolveChannels]  Phase 65 C1: async
 *        ({tenantId, propertyId, eventType}) => Array<channelCode|{channel,enabled}>
 *        returning the ENABLED channels for that property. Without it the spine
 *        fans out to nothing and says so — it never guesses a channel.
 */
function buildChannelSubscriber({ eventBus, store, queue, resolveChannels } = {}) {
  if (!eventBus) throw new Error('channelSubscriber: eventBus required');
  if (_active) return _active;
  const mapping = store || getDefaultStore();
  const syncQueue = queue || getDefaultQueue();
  let warnedNoResolver = false;

  const unsubs = SUBSCRIBED_EVENTS.map((type) => eventBus.subscribe(type, async (event) => {
    try {
      const canonical = normalize(event);              // pure
      // Phase 65 C1: one job per ENABLED mapped channel, canonical codes only.
      const fan = await fanOutAndEnqueue(syncQueue, canonical, resolveChannels);
      // The in-memory mapping store still records a single sync state per
      // reservation; link it to the first routed channel when there is one.
      const firstRouted = fan.channels.length
        ? { channel: fan.channels[0] }
        : null;
      const syncState = applyToStore(mapping, canonical, firstRouted);

      if (!fan.ok) {
        if (fan.reason === 'channel_registry_unavailable' && typeof resolveChannels !== 'function') {
          // Deployment has not wired a resolver. Announce once, loudly, then
          // stay quiet — but never invent a channel.
          if (!warnedNoResolver) {
            warnedNoResolver = true;
            logger.error({ code: 'channel_registry_unavailable' },
              '[channelSubscriber] no channel resolver wired - NO outbound job will be enqueued');
          }
        } else {
          logger.error({ code: fan.reason, detail: fan.detail, event_type: canonical.event },
            '[channelSubscriber] fan-out refused - failing closed');
        }
      }

      const refused = fan.enqueued.filter((e) => e.result && e.result.accepted === false);
      if (refused.length) {
        logger.error({ refused: refused.map((r) => ({ channel: r.channel, reason: r.result.reason })) },
          '[channelSubscriber] some channel jobs were refused');
      }

      logger.info({
        spine: 'pms->cm',
        tenant_id: canonical.tenant_id, property_id: canonical.property_id,
        event_type: canonical.event, reservation_id: canonical.reservation_id,
        channels: fan.channels, enqueued: fan.enqueued.length, syncState, ok: fan.ok
      }, '[channelSubscriber] captured');
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

module.exports = {
  buildChannelSubscriber, normalize, applyToStore, enqueueRouted,
  fanOutAndEnqueue,
  getDefaultStore, getDefaultQueue, SUBSCRIBED_EVENTS, STATE_MAP
};
