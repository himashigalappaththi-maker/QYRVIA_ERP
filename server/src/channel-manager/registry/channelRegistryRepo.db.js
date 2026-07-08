'use strict';

/**
 * Phase 49 — DB-backed channel registry repository.
 * SQL matches migration 0055_channel_registry.sql.
 * All writes go through a tenant-scoped client so RLS applies.
 */

function buildChannelRegistryRepoDb({ db }) {
  if (!db || typeof db.query !== 'function') throw new Error('channelRegistryRepoDb: db.query required');

  async function list({ tenantId, propertyId }) {
    const r = await db.query(
      `SELECT * FROM channel_registry
       WHERE tenant_id = $1
         AND (property_id = $2 OR ($2::uuid IS NULL AND property_id IS NULL))
       ORDER BY created_at`,
      [tenantId, propertyId || null]
    );
    return r.rows;
  }

  async function findByCode(channelCode, { tenantId, propertyId }) {
    const r = await db.query(
      `SELECT * FROM channel_registry
       WHERE tenant_id = $1
         AND channel_code = $2
         AND (property_id = $3 OR ($3::uuid IS NULL AND property_id IS NULL))`,
      [tenantId, channelCode, propertyId || null]
    );
    return r.rows[0] || null;
  }

  async function seed(row) {
    const r = await db.query(
      `INSERT INTO channel_registry
         (tenant_id, property_id, channel_code, display_name, enabled, status, commission_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, property_id, channel_code) DO NOTHING
       RETURNING *`,
      [row.tenant_id, row.property_id || null, row.channel_code,
       row.display_name, row.enabled, row.status, row.commission_pct ?? null]
    );
    if (r.rows[0]) return r.rows[0];
    // Row already existed — return it
    return findByCode(row.channel_code, { tenantId: row.tenant_id, propertyId: row.property_id });
  }

  async function upsert(row) {
    const r = await db.query(
      `INSERT INTO channel_registry
         (tenant_id, property_id, channel_code, display_name, enabled, status, commission_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, property_id, channel_code)
       DO UPDATE SET display_name = EXCLUDED.display_name,
                     commission_pct = EXCLUDED.commission_pct,
                     updated_at = now()
       RETURNING *`,
      [row.tenant_id, row.property_id || null, row.channel_code,
       row.display_name, row.enabled ?? false, row.status ?? 'not_configured',
       row.commission_pct ?? null]
    );
    return r.rows[0];
  }

  async function updateFields(channelCode, fields, { tenantId, propertyId }) {
    const sets = [];
    const vals = [tenantId, channelCode, propertyId || null];
    if (fields.status     !== undefined) { vals.push(fields.status);     sets.push(`status = $${vals.length}`); }
    if (fields.enabled    !== undefined) { vals.push(fields.enabled);    sets.push(`enabled = $${vals.length}`); }
    if (fields.last_sync_at !== undefined) { vals.push(fields.last_sync_at); sets.push(`last_sync_at = $${vals.length}`); }
    if (fields.last_error !== undefined) { vals.push(fields.last_error); sets.push(`last_error = $${vals.length}`); }
    if (!sets.length) return findByCode(channelCode, { tenantId, propertyId });
    sets.push('updated_at = now()');
    const r = await db.query(
      `UPDATE channel_registry SET ${sets.join(', ')}
       WHERE tenant_id = $1 AND channel_code = $2
         AND (property_id = $3 OR ($3::uuid IS NULL AND property_id IS NULL))
       RETURNING *`,
      vals
    );
    return r.rows[0] || null;
  }

  async function toggle(channelCode, ctx) {
    const r = await db.query(
      `UPDATE channel_registry
       SET enabled = NOT enabled, updated_at = now()
       WHERE tenant_id = $1 AND channel_code = $2
         AND (property_id = $3 OR ($3::uuid IS NULL AND property_id IS NULL))
       RETURNING *`,
      [ctx.tenantId, channelCode, ctx.propertyId || null]
    );
    return r.rows[0] || null;
  }

  return { list, findByCode, seed, upsert, updateFields, toggle };
}

module.exports = { buildChannelRegistryRepoDb };
