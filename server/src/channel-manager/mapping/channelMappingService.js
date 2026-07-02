'use strict';

/**
 * channelMappingService (Phase 24 B8-B2) - mapping management over the
 * channel_mapping_store: PMS room_type -> OTA room (ota_room_id), PMS rate_plan ->
 * OTA rate plan (ota_rate_plan_id), property -> OTA property (ota_property_id).
 *
 * Adds, on every change: monotonic `mapping_version`, an append-only history
 * snapshot, and a SAFE audit event (metadata only - never credentials/secrets).
 * Internal data only: no OTA calls, no network.
 */

function buildChannelMappingService({ mappingStore, historyStore, clock = () => Date.now(), onAudit } = {}) {
  if (!mappingStore) throw new Error('channelMappingService: mappingStore required');
  if (!historyStore) throw new Error('channelMappingService: historyStore required');

  function emitAudit(type, meta) {
    if (typeof onAudit === 'function') { try { onAudit(Object.assign({ type }, meta)); } catch (_) { /* audit never throws */ } }
  }

  function snapshot(row, change_type, actor_id) {
    historyStore.append({
      tenant_id: row.tenant_id, property_id: row.property_id || null, channel: row.channel,
      room_type_id: row.room_type_id, ota_room_id: row.ota_room_id || null,
      ota_rate_plan_id: row.ota_rate_plan_id || null, ota_property_id: row.ota_property_id || null,
      enabled: row.enabled, mapping_version: row.mapping_version, change_type,
      actor_id: actor_id || null, changed_at: clock()
    });
  }

  // Create or update a (tenant, property, channel, room_type) mapping. Partial
  // updates merge with the existing row; version bumps; history + audit recorded.
  function upsertMapping(input, { actor_id } = {}) {
    if (!input || !input.tenant_id || !input.channel || !input.room_type_id) {
      return { ok: false, error: 'tenant_channel_room_type_required' };
    }
    const { tenant_id, property_id = null, channel, room_type_id } = input;
    const existing = mappingStore.getMapping(tenant_id, property_id, channel, room_type_id);
    const change_type = existing ? 'UPDATED' : 'CREATED';
    const mapping_version = existing ? (existing.mapping_version || 1) + 1 : 1;
    const merged = Object.assign({}, existing || {}, input, { mapping_version });
    if (merged.enabled === undefined) merged.enabled = existing ? existing.enabled : true;

    const res = mappingStore.upsertMapping(merged);
    snapshot(res.item, change_type, actor_id);
    emitAudit('channel.mapping_' + change_type.toLowerCase(), { tenant_id, channel, room_type_id, mapping_version });
    return { ok: true, item: res.item, change_type, mapping_version };
  }

  function setEnabled(key, enabled, { actor_id } = {}) {
    if (!key || !key.tenant_id || !key.channel || !key.room_type_id) return { ok: false, error: 'tenant_channel_room_type_required' };
    const existing = mappingStore.getMapping(key.tenant_id, key.property_id || null, key.channel, key.room_type_id);
    if (!existing) return { ok: false, error: 'mapping_not_found' };
    const mapping_version = (existing.mapping_version || 1) + 1;
    const merged = Object.assign({}, existing, { enabled: !!enabled, mapping_version });
    const res = mappingStore.upsertMapping(merged);
    const change_type = enabled ? 'ENABLED' : 'DISABLED';
    snapshot(res.item, change_type, actor_id);
    emitAudit('channel.mapping_' + change_type.toLowerCase(), { tenant_id: key.tenant_id, channel: key.channel, room_type_id: key.room_type_id, mapping_version });
    return { ok: true, item: res.item, change_type, mapping_version };
  }

  function getMapping(tenant_id, property_id, channel, room_type_id) {
    return mappingStore.getMapping(tenant_id, property_id, channel, room_type_id);
  }

  function listMappings(filter) {
    const all = mappingStore.list().mappings || [];
    if (!filter) return all;
    return all.filter((m) => Object.entries(filter).every(([k, v]) => m[k] === v));
  }

  function getHistory(filter) { return historyStore.list(filter); }

  return { upsertMapping, setEnabled, getMapping, listMappings, getHistory };
}

module.exports = { buildChannelMappingService };
