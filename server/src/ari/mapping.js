'use strict';

/**
 * Internal ARI mapping layer (Phase 30.1) - RoomType <-> RatePlan <-> Channel.
 *
 * Backend model ONLY (no UI, no OTA codes resolution beyond carrying them). It
 * answers: for a channel, which (roomType, ratePlan) pairs are exposed, and what
 * OTA-side codes they map to. When a property has NO mappings for a channel, the
 * default is "expose everything" (direct/unfiltered) so the engine stays usable
 * before any channel is configured.
 */

function indexMappings(mappings) {
  // key: channel|roomTypeId|ratePlanId -> mapping
  const byKey = new Map();
  const channels = new Set();
  for (const m of mappings || []) {
    channels.add(m.channel);
    byKey.set(m.channel + '|' + m.roomTypeId + '|' + m.ratePlanId, m);
  }
  return { byKey, channels };
}

function buildMappingIndex(mappings) {
  const { byKey, channels } = indexMappings(mappings);

  function isExposed(channel, roomTypeId, ratePlanId) {
    if (!channel) return true;                 // direct / no channel filter
    if (!channels.has(channel)) return true;   // channel not configured => expose all
    const m = byKey.get(channel + '|' + roomTypeId + '|' + ratePlanId);
    return !!(m && m.enabled);
  }

  function otaCodes(channel, roomTypeId, ratePlanId) {
    const m = channel ? byKey.get(channel + '|' + roomTypeId + '|' + ratePlanId) : null;
    return m ? { otaRoomId: m.otaRoomId, otaRatePlanId: m.otaRatePlanId } : { otaRoomId: null, otaRatePlanId: null };
  }

  return { isExposed, otaCodes, channels };
}

module.exports = { buildMappingIndex };
