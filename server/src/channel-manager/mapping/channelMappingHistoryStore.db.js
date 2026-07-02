'use strict';

/**
 * DB append-only mapping history store (Phase 24 B8-B2). DORMANT until db-mode.
 * SQL matches migration 0048. Production db-mode routes through a tenant-scoped
 * client (client.withTenant) so RLS applies.
 */

function buildChannelMappingHistoryStoreDb({ db }) {
  if (!db || typeof db.query !== 'function') throw new Error('channelMappingHistoryStoreDb: db.query required');
  return {
    async append(rec) {
      const r = await db.query(
        `INSERT INTO channel_mapping_history
           (tenant_id, property_id, channel, room_type_id, ota_room_id, ota_rate_plan_id, ota_property_id,
            enabled, mapping_version, change_type, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [rec.tenant_id, rec.property_id || null, rec.channel || null, rec.room_type_id || null,
         rec.ota_room_id || null, rec.ota_rate_plan_id || null, rec.ota_property_id || null,
         rec.enabled != null ? rec.enabled : null, rec.mapping_version, rec.change_type, rec.actor_id || null]
      );
      return { accepted: true, item: r.rows[0] };
    },
    async list(filter) {
      const t = filter && filter.tenant_id;
      const r = t ? await db.query('SELECT * FROM channel_mapping_history WHERE tenant_id = $1 ORDER BY changed_at, id', [t])
                  : await db.query('SELECT * FROM channel_mapping_history ORDER BY changed_at, id', []);
      return r.rows;
    },
    async clear() { await db.query('DELETE FROM channel_mapping_history', []); }
  };
}

module.exports = { buildChannelMappingHistoryStoreDb };
