'use strict';

/**
 * channelEventRouter — PURE, deterministic mapping from a PMS domain event to
 * one channel action PER MAPPED CHANNEL. No side effects: no I/O, no OTA, no DB.
 *
 * PHASE 65 C1 — CANONICAL PER-OTA FAN-OUT
 * ───────────────────────────────────────
 * This module used to emit a single job stamped with the LITERAL
 *
 *     const ROUTE_TARGET = 'channel-manager';
 *
 * which is not an OTA code at all. Nothing downstream can resolve a provider for
 * it — realProcessor rejects it as `no_provider_for_channel` — so the outbound
 * spine could never deliver anything to any channel. That literal is gone: a
 * routed job now always carries a canonical CHANNELS code.
 *
 * The fan-out set is supplied BY THE CALLER (the subscriber), which owns the
 * registry lookup. Keeping that lookup out of this module preserves the property
 * that makes this file trivially testable: it is pure, performs no I/O, and
 * given the same inputs always produces the same jobs.
 *
 * FAIL CLOSED: an unrecognised channel code is a hard error
 * (`channel_identity_invalid`), never a silently skipped or silently rerouted
 * job. Routing a reservation to the wrong channel and quietly dropping it are
 * both worse than refusing.
 */

const { CHANNELS } = require('../core/canonical/types');

const EVENT_ACTION_MAP = Object.freeze({
  'reservation.created':     'CREATE_BOOKING',
  'reservation.updated':     'UPDATE_BOOKING',
  'reservation.cancelled':   'CANCEL_BOOKING',
  'reservation.checked_in':  'CHECK_IN',
  'reservation.checked_out': 'CHECK_OUT'
});

/**
 * Channel codes a NEW job may be created with.
 *
 * QTCN is deliberately excluded. It stays in the CHANNELS constant as a legacy
 * alias so historical queue rows, registry rows and configuration can still be
 * READ, but nothing new is ever written with it — the canonical identity for
 * QYRVIA Connect is QYRVIA_CONNECT.
 */
const ROUTABLE_CHANNELS = Object.freeze([
  CHANNELS.BOOKING_COM,
  CHANNELS.AGODA,
  CHANNELS.EXPEDIA,
  CHANNELS.AIRBNB,
  CHANNELS.MAKEMYTRIP,
  CHANNELS.GOOGLE,
  CHANNELS.TRIPADVISOR,
  CHANNELS.QYRVIA_CONNECT
]);

const ROUTABLE_SET = new Set(ROUTABLE_CHANNELS);

/** Legacy codes accepted when READING existing state, never when writing. */
const LEGACY_CHANNEL_ALIASES = Object.freeze({
  QTCN: CHANNELS.QYRVIA_CONNECT,
  qytn: CHANNELS.QYRVIA_CONNECT
});

/** Normalise a historical code to its canonical form. Read path only. */
function canonicalChannelCode(code) {
  if (code == null) return null;
  const raw = String(code);
  if (ROUTABLE_SET.has(raw)) return raw;
  if (Object.prototype.hasOwnProperty.call(LEGACY_CHANNEL_ALIASES, raw)) {
    return LEGACY_CHANNEL_ALIASES[raw];
  }
  return null;
}

/** eventType -> action | null (unknown types map to null, never throw). */
function actionFor(eventType) {
  return EVENT_ACTION_MAP[eventType] || null;
}

function invalidChannel(code) {
  const e = new Error('channel_identity_invalid: ' + String(code));
  e.code = 'channel_identity_invalid';
  e.channel = code == null ? null : String(code);
  return e;
}

/**
 * Route one canonical event to ONE named channel.
 * @returns {{channel:string, action:string, payload:object}|null}
 *          null when the event type maps to no action.
 * @throws  channel_identity_invalid when `channel` is not a routable code.
 */
function route(canonical, channel) {
  if (!canonical || !canonical.event) return null;
  if (!ROUTABLE_SET.has(channel)) throw invalidChannel(channel);
  const action = actionFor(canonical.event);
  if (!action) return null;
  return { channel, action, payload: canonical };
}

/**
 * Route one canonical event to EVERY supplied channel — the fan-out.
 *
 * @param {object} canonical  the normalised event
 * @param {Array<string|{channel?:string, code?:string, channel_code?:string, enabled?:boolean}>} channels
 *        The ENABLED channel mappings for this (tenant, property). The caller
 *        has already excluded disabled channels; an entry carrying an explicit
 *        `enabled: false` is defensively skipped here as well.
 * @returns {Array<{channel:string, action:string, payload:object}>}
 *          Empty when the event maps to no action, or when nothing is mapped —
 *          an empty mapping set is a legitimate state, not an error.
 * @throws  channel_identity_invalid on any unrecognised code.
 */
function routeAll(canonical, channels) {
  if (!canonical || !canonical.event) return [];
  if (!Array.isArray(channels)) throw invalidChannel(channels);
  const action = actionFor(canonical.event);
  if (!action) return [];

  const out = [];
  const seen = new Set();
  for (const entry of channels) {
    if (entry && typeof entry === 'object' && entry.enabled === false) continue;
    const raw = (entry && typeof entry === 'object')
      ? (entry.channel || entry.code || entry.channel_code)
      : entry;

    // A historical row may still carry QTCN/qytn; canonicalise it for the new
    // job rather than refusing — but never emit the legacy code itself.
    const code = canonicalChannelCode(raw);
    if (!code) throw invalidChannel(raw);
    if (seen.has(code)) continue;          // one job per channel, never two
    seen.add(code);
    out.push({ channel: code, action, payload: canonical });
  }
  return out;
}

module.exports = {
  route,
  routeAll,
  actionFor,
  canonicalChannelCode,
  EVENT_ACTION_MAP,
  ROUTABLE_CHANNELS,
  LEGACY_CHANNEL_ALIASES
};
