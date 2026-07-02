'use strict';

/**
 * conversationStateStore (Phase 27) - EPHEMERAL in-memory conversation memory.
 * No persistence, no CRM. Keyed by conversationId; entries expire after a TTL.
 * Holds slot-filling state: guest_name, arrival, departure, adults, children,
 * room_type, booking_reference.
 */

function buildConversationStateStore({ clock = () => Date.now(), ttlMs = 30 * 60 * 1000 } = {}) {
  const map = new Map();

  function get(id) {
    const e = map.get(id);
    if (!e) return {};
    if (ttlMs && (clock() - e.updated_at) > ttlMs) { map.delete(id); return {}; }
    return Object.assign({}, e.state);
  }

  function merge(id, patch) {
    const next = get(id);
    for (const [k, v] of Object.entries(patch || {})) if (v != null && v !== '') next[k] = v;
    map.set(id, { state: next, updated_at: clock() });
    return Object.assign({}, next);
  }

  function set(id, state) { map.set(id, { state: Object.assign({}, state), updated_at: clock() }); return get(id); }
  function clear(id) { map.delete(id); }
  function size() { return map.size; }

  return { get, merge, set, clear, size };
}

module.exports = { buildConversationStateStore };
