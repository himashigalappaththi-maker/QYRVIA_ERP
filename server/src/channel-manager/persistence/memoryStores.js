'use strict';

/**
 * In-memory implementations of the channel persistence contracts (Phase 24 B1).
 *
 * These are the DEFAULT (CHANNEL_PERSISTENCE=memory) and the reference behavior
 * the DB implementations must match. Pure, deterministic (injectable clock),
 * no I/O, no OTA, no DB. The queue reuses the existing S3 channelSyncQueue so
 * there is a single source of truth for queue semantics.
 */

const { buildChannelSyncQueue } = require('../services/channelSyncQueue');

const clone = (o) => (o ? Object.assign({}, o) : null);
const matches = (it, filter) => !filter || Object.entries(filter).every(([k, v]) => it[k] === v);

// ---- booking_store ---------------------------------------------------------
function buildBookingStoreMemory({ clock = () => Date.now() } = {}) {
  const byId  = new Map();
  const byRef = new Map(); // tenant::channel::external_ref -> id
  let seq = 0;
  const nid = () => 'bk_' + (++seq);
  const refKey = (t, c, r) => `${t}::${c}::${r}`;

  function upsert(row) {
    if (!row || !row.tenant_id || !row.channel || !row.external_ref) return { accepted: false, reason: 'invalid' };
    const key = refKey(row.tenant_id, row.channel, row.external_ref);
    const id  = byRef.get(key);
    const now = clock();
    if (id) {
      const existing = byId.get(id);
      const updated = Object.assign({}, existing, row, {
        id: existing.id, version: (existing.version || 1) + 1, created_at: existing.created_at, updated_at: now
      });
      byId.set(id, updated);
      return { accepted: true, created: false, item: clone(updated) };
    }
    const newId = nid();
    const item = Object.assign({ pms_reservation_id: null, source_channel: row.channel, version: 1 }, row, {
      id: newId, created_at: now, updated_at: now
    });
    byId.set(newId, item);
    byRef.set(key, newId);
    return { accepted: true, created: true, item: clone(item) };
  }
  function getById(id) { return clone(byId.get(id)); }
  function getByExternalRef(t, c, r) { const id = byRef.get(refKey(t, c, r)); return id ? clone(byId.get(id)) : null; }
  function setPmsReservationId(id, resId) {
    const it = byId.get(id); if (!it) return null;
    it.pms_reservation_id = resId; it.updated_at = clock(); return clone(it);
  }
  function list(filter) { const out = []; for (const it of byId.values()) if (matches(it, filter)) out.push(clone(it)); return out; }
  function clear() { byId.clear(); byRef.clear(); seq = 0; }

  return { upsert, getById, getByExternalRef, setPmsReservationId, list, clear };
}

// ---- channel_mapping_store -------------------------------------------------
function buildChannelMappingStoreMemory() {
  const maps  = new Map(); // tenant::property::channel::room_type -> row
  const links = new Map(); // tenant::reservation::channel -> row
  const mk = (t, p, c, rt) => `${t}::${p == null ? '' : p}::${c}::${rt}`;
  const lk = (t, r, c) => `${t}::${r}::${c}`;

  function upsertMapping(row) {
    if (!row || !row.tenant_id || !row.channel || !row.room_type_id) return { accepted: false, reason: 'invalid' };
    const key = mk(row.tenant_id, row.property_id, row.channel, row.room_type_id);
    const existing = maps.get(key);
    const merged = Object.assign({ enabled: true, credentials_ref: null, ota_room_id: null, ota_rate_plan_id: null }, existing || {}, row);
    maps.set(key, merged);
    return { accepted: true, created: !existing, item: clone(merged) };
  }
  function getMapping(t, p, c, rt) { return clone(maps.get(mk(t, p, c, rt))); }
  function linkReservation(row) {
    if (!row || !row.tenant_id || !row.reservation_id || !row.channel) return { accepted: false, reason: 'invalid' };
    const key = lk(row.tenant_id, row.reservation_id, row.channel);
    const existing = links.get(key);
    const merged = Object.assign({ external_id: null }, existing || {}, row);
    links.set(key, merged);
    return { accepted: true, created: !existing, item: clone(merged) };
  }
  function getReservationLink(t, r, c) { return clone(links.get(lk(t, r, c))); }
  function list() {
    return {
      mappings: Array.from(maps.values()).map(clone),
      links:    Array.from(links.values()).map(clone)
    };
  }
  function clear() { maps.clear(); links.clear(); }

  return { upsertMapping, getMapping, linkReservation, getReservationLink, list, clear };
}

// ---- channel_dead_letter_store --------------------------------------------
function buildDeadLetterStoreMemory({ clock = () => Date.now() } = {}) {
  const byId  = new Map();
  const byKey = new Map(); // coalesce key -> id
  let seq = 0;
  const nid = () => 'dl_' + (++seq);
  const ck = (t, r, a, g) => `${t}::${r}::${a}::${g || 0}`;

  function insert(rec) {
    if (!rec || !rec.tenant_id || !rec.reservation_id || !rec.action) return { accepted: false, reason: 'invalid' };
    const gen = rec.dedupe_generation || 0;
    const key = ck(rec.tenant_id, rec.reservation_id, rec.action, gen);
    const existingId = byKey.get(key);
    if (existingId) {
      const it = byId.get(existingId);
      it.attempts = (it.attempts || 0) + 1;
      if (rec.last_error) it.last_error = rec.last_error;
      it.updated_at = clock();
      return { accepted: true, coalesced: true, item: clone(it) };
    }
    const id = nid();
    const item = Object.assign({ reprocess_requested: false, attempts: 1, dedupe_generation: gen }, rec, {
      id, created_at: clock(), updated_at: clock()
    });
    byId.set(id, item);
    byKey.set(key, id);
    return { accepted: true, coalesced: false, item: clone(item) };
  }
  function get(id) { return clone(byId.get(id)); }
  function list(filter) { const out = []; for (const it of byId.values()) if (matches(it, filter)) out.push(clone(it)); return out; }
  function requestReprocess(id) { const it = byId.get(id); if (!it) return null; it.reprocess_requested = true; it.updated_at = clock(); return clone(it); }
  function clear() { byId.clear(); byKey.clear(); seq = 0; }

  return { insert, get, list, requestReprocess, clear };
}

// ---- channel_sync_state_store ---------------------------------------------
function buildSyncStateStoreMemory({ clock = () => Date.now() } = {}) {
  const byKey = new Map();
  const sk = (t, c, r) => `${t}::${c}::${r}`;

  function upsert(row) {
    if (!row || !row.tenant_id || !row.channel || !row.resource_key) return { accepted: false, reason: 'invalid' };
    const key = sk(row.tenant_id, row.channel, row.resource_key);
    const existing = byKey.get(key);
    const merged = Object.assign(
      { last_hash: null, last_status: null, last_error: null, reservation_id: null }, existing || {}, row,
      { last_sync_at: row.last_sync_at != null ? row.last_sync_at : clock() }
    );
    byKey.set(key, merged);
    return { accepted: true, created: !existing, item: clone(merged) };
  }
  function get(t, c, r) { return clone(byKey.get(sk(t, c, r))); }
  function list(filter) { const out = []; for (const it of byKey.values()) if (matches(it, filter)) out.push(clone(it)); return out; }
  function clear() { byKey.clear(); }

  return { upsert, get, list, clear };
}

module.exports = {
  buildBookingStoreMemory,
  buildChannelMappingStoreMemory,
  buildSyncQueueStoreMemory: buildChannelSyncQueue, // reuse S3 queue (contract-compatible)
  buildDeadLetterStoreMemory,
  buildSyncStateStoreMemory
};
