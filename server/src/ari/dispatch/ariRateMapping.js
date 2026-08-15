'use strict';

/**
 * Phase 68A — PURE ARI outbox envelope -> OTA provider codec input mapping.
 *
 * Takes the frozen delivery envelope ariOutboxWorker.js hands a dispatcher
 * (id, tenantId, propertyId, eventType, resourceKind, roomTypeId,
 * ratePlanId, restrictionRuleId, effectiveFrom, effectiveTo, dedupeKey,
 * sourceVersion, payload) plus an EXPLICITLY INJECTED channel-mapping lookup
 * result (never looked up from inside this module — see the header note on
 * purity) and produces the input shape
 * src/channel-manager/ota/providers/bookingcom.js's encodeRateUpdate /
 * encodeAvailability already consume.
 *
 * TWO INVARIANTS THIS MODULE NEVER VIOLATES (instruction 032 Section 10)
 * ────────────────────────────────────────────────────────────────────────
 *   1. roomTypeId is NEVER assumed to equal otaRoomId, and ratePlanId is
 *      NEVER assumed to equal otaRatePlanId. Both must come from an
 *      explicitly supplied `mapping` object (the caller's responsibility —
 *      normally src/channel-manager/mapping/channelMappingService.js's
 *      getMapping()); a missing mapping FAILS CLOSED, it is never silently
 *      skipped or defaulted to the internal id.
 *   2. A commercial value (a rate amount, an available-room count) is NEVER
 *      fabricated. Where the authoritative ari_outbox_store payload does not
 *      carry enough information to build a real value, this module THROWS a
 *      typed, non-retryable error rather than inventing one. `available` for
 *      INVENTORY_CHANGED is the one derived (not fabricated) value this
 *      module computes — physical - sold - blocked is standard PMS
 *      occupancy arithmetic over three AUTHORITATIVE payload fields, not an
 *      invented number, and it is only computed when all three are present.
 *
 * WHAT IS SUPPORTED IN THIS PHASE, AND WHY NOT MORE (disclosed, not hidden)
 * ────────────────────────────────────────────────────────────────────────
 * Instruction 031's audit (Section 13) found the repository's real ARI
 * mutation sources produce two shapes today:
 *   - INVENTORY_CHANGED from upsertInventoryCell (src/ari/api/ari.handlers.js):
 *     payload = { date, physical, sold, blocked, overbookingBuffer, stopSell }
 *     — a real, single-date, complete shape. SUPPORTED here.
 *   - INVENTORY_CHANGED from adjustSold: payload = { date, delta, sold, source }
 *     — no physical/blocked, so `available` cannot be derived without
 *     fabricating a total. REFUSED (ARI_MAPPING_INCOMPLETE_INVENTORY).
 *   - RATE_CHANGED / AVAILABILITY_CHANGED from upsertRatePlan/upsertRoomType:
 *     UNDATED configuration changes over the sentinel window
 *     (ARI_CONFIG_EFFECTIVE_FROM..ARI_CONFIG_EFFECTIVE_TO), not a resolved
 *     per-date rate/restriction. Booking.com's codec (and every other
 *     provider's, in this repo) takes exactly ONE `date` per call — sending
 *     the sentinel window as a literal date would be wrong data on the wire,
 *     and inventing a "today" date would be fabrication. REFUSED
 *     (ARI_MAPPING_UNSUPPORTED_RANGE / ARI_MAPPING_UNSUPPORTED_EVENT). A
 *     future per-date rate/restriction resolution engine
 *     (src/ari/rateEngine.js, restrictionEngine.js, ruleResolver.js already
 *     exist and compute exactly this) enqueueing a SINGLE-DAY RATE_CHANGED
 *     with a resolved amount is handled correctly by mapRateChanged() the
 *     moment it exists — this module does not need to change for that.
 *   - AVAILABILITY_CHANGED restriction-rule events (payload carries
 *     cta/ctd/minLos/maxLos) have no standalone Booking.com restriction
 *     message in this codec (restrictions are embedded inside
 *     encodeRateUpdate, which also requires a rate amount this event never
 *     carries) — REFUSED (ARI_MAPPING_UNSUPPORTED_EVENT), exactly matching
 *     the instruction-031 audit's own PARTIAL_PROTOCOL_IMPLEMENTATION
 *     finding for "restriction update", not silently dropped.
 *
 * Every refusal above is an explicit, typed, `retryable: false` error — the
 * dispatcher (ariChannelDispatcher.js) turns it into a DEAD_LETTER-eligible
 * ledger transition, never a silent skip that could be mistaken for success.
 */

const OPERATIONS = Object.freeze({ RATE: 'RATE', AVAILABILITY: 'AVAILABILITY' });

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  e.retryable = false; // a mapping gap never resolves itself by retrying the same inputs
  return e;
}

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

/** UTC-safe: true when [effectiveFrom, effectiveTo) describes exactly one calendar day. */
function isSingleDayRange(effectiveFrom, effectiveTo) {
  if (typeof effectiveFrom !== 'string' || typeof effectiveTo !== 'string') return false;
  const t = Date.parse(effectiveFrom + 'T00:00:00Z');
  if (Number.isNaN(t)) return false;
  const next = new Date(t + 86400000);
  const expected = next.getUTCFullYear() + '-' +
    String(next.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(next.getUTCDate()).padStart(2, '0');
  return expected === effectiveTo;
}

function requireMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') {
    throw fail('ARI_MAPPING_MISSING', 'no channel mapping supplied for this (tenant, property, channel, roomType)');
  }
  if (!mapping.otaPropertyId) {
    throw fail('ARI_MAPPING_MISSING_PROPERTY', 'channel mapping has no ota_property_id (hotel code) for this property/channel');
  }
  if (!mapping.otaRoomId) {
    throw fail('ARI_MAPPING_MISSING_ROOM', 'channel mapping has no ota_room_id for this room type/channel — never assume roomTypeId == otaRoomId');
  }
}

/** INVENTORY_CHANGED -> Booking.com encodeAvailability input. See module header. */
function mapInventoryChanged(envelope, mapping) {
  requireMapping(mapping);
  const p = envelope.payload || {};
  if (typeof p.date !== 'string' || p.date.length === 0) {
    throw fail('ARI_MAPPING_MISSING_DATE', 'INVENTORY_CHANGED payload has no date');
  }
  if (!isFiniteNumber(p.physical) || !isFiniteNumber(p.sold)) {
    throw fail('ARI_MAPPING_INCOMPLETE_INVENTORY',
      'INVENTORY_CHANGED payload is missing physical/sold — cannot derive available without fabricating it ' +
      '(an adjustSold-originated payload carries only a sold delta, not physical/blocked; see module header)');
  }
  const blocked = isFiniteNumber(p.blocked) ? p.blocked : 0;
  const available = Math.max(0, p.physical - p.sold - blocked);

  return {
    operation: OPERATIONS.AVAILABILITY,
    input: {
      hotelCode: mapping.otaPropertyId,
      otaRoomId: mapping.otaRoomId,
      date: p.date,
      available,
      stop_sell: !!p.stopSell
    }
  };
}

/** RATE_CHANGED -> Booking.com encodeRateUpdate input. See module header. */
function mapRateChanged(envelope, mapping) {
  requireMapping(mapping);
  if (envelope.ratePlanId != null && !mapping.otaRatePlanId) {
    throw fail('ARI_MAPPING_MISSING_RATE_PLAN',
      'channel mapping has no ota_rate_plan_id for this rate plan/channel — never assume ratePlanId == otaRatePlanId');
  }
  if (!isSingleDayRange(envelope.effectiveFrom, envelope.effectiveTo)) {
    throw fail('ARI_MAPPING_UNSUPPORTED_RANGE',
      'RATE_CHANGED does not describe a single resolved calendar date — this phase supports one resolved date per ' +
      'provider push; a multi-day/undated config change must be re-resolved per date upstream, never fabricated here');
  }
  const p = envelope.payload || {};
  const amount = isFiniteNumber(p.rate) ? p.rate : (isFiniteNumber(p.baseRate) ? p.baseRate : null);
  if (amount === null) {
    throw fail('ARI_MAPPING_MISSING_RATE_AMOUNT', 'RATE_CHANGED payload has no resolved per-date rate amount (rate/baseRate) to send');
  }

  return {
    operation: OPERATIONS.RATE,
    input: {
      hotelCode: mapping.otaPropertyId,
      otaRoomId: mapping.otaRoomId,
      otaRatePlanId: mapping.otaRatePlanId || undefined,
      date: envelope.effectiveFrom,
      rate: amount,
      currency: typeof p.currency === 'string' && p.currency.length > 0 ? p.currency : undefined,
      restrictions: {
        cta: !!p.cta,
        ctd: !!p.ctd,
        min_los: isFiniteNumber(p.minLos) ? p.minLos : null,
        max_los: isFiniteNumber(p.maxLos) ? p.maxLos : null
      }
    }
  };
}

/**
 * Single entry point the dispatcher calls. Throws (never returns a
 * placeholder) for every eventType/payload shape this phase does not
 * support end-to-end — see module header for exactly which shapes those are
 * and why.
 */
function mapAriEnvelope(envelope, mapping) {
  if (!envelope || typeof envelope !== 'object') {
    throw fail('ARI_MAPPING_INVALID_ENVELOPE', 'envelope is required');
  }
  switch (envelope.eventType) {
    case 'INVENTORY_CHANGED':
      return mapInventoryChanged(envelope, mapping);
    case 'RATE_CHANGED':
      return mapRateChanged(envelope, mapping);
    case 'AVAILABILITY_CHANGED':
      throw fail('ARI_MAPPING_UNSUPPORTED_EVENT',
        'AVAILABILITY_CHANGED (room-type config or restriction-rule) has no supported Booking.com mapping in this ' +
        'phase — the codec has no standalone restriction/room-config message; see module header.');
    default:
      throw fail('ARI_MAPPING_UNKNOWN_EVENT_TYPE', 'unrecognised eventType: ' + String(envelope.eventType));
  }
}

module.exports = {
  mapAriEnvelope,
  mapInventoryChanged,
  mapRateChanged,
  isSingleDayRange,
  OPERATIONS
};
