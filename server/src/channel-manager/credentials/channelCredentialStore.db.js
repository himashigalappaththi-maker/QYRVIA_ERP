'use strict';

/**
 * DB channel credential store (Phase 24 B8-B1). DORMANT until db-mode credential
 * activation. Stores only encrypted_payload; never plaintext. SQL matches
 * migration 0047. Production db-mode must route through a tenant-scoped client
 * (client.withTenant -> SET app.tenant_id) so RLS applies.
 */

function buildChannelCredentialStoreDb({ db }) {
  if (!db || typeof db.query !== 'function') throw new Error('channelCredentialStoreDb: db.query required');
  return {
    async put(row) {
      const r = await db.query(
        `INSERT INTO channel_credential_store
           (tenant_id, property_id, channel, credentials_ref, credential_type, encrypted_payload, key_version, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, credentials_ref)
         DO UPDATE SET property_id = EXCLUDED.property_id, channel = EXCLUDED.channel,
                       credential_type = EXCLUDED.credential_type, encrypted_payload = EXCLUDED.encrypted_payload,
                       key_version = EXCLUDED.key_version, status = EXCLUDED.status, updated_at = now()
         RETURNING *`,
        [row.tenant_id, row.property_id || null, row.channel || null, row.credentials_ref,
         row.credential_type || 'API_KEY', row.encrypted_payload || {}, row.key_version || 1, row.status || 'ACTIVE']
      );
      return { accepted: true, item: r.rows[0] };
    },
    async get(tenant_id, credentials_ref) {
      const r = await db.query('SELECT * FROM channel_credential_store WHERE tenant_id = $1 AND credentials_ref = $2', [tenant_id, credentials_ref]);
      return r.rows[0] || null;
    },
    async updatePayload(tenant_id, credentials_ref, patch = {}) {
      const r = await db.query(
        `UPDATE channel_credential_store SET
           encrypted_payload = COALESCE($3, encrypted_payload),
           key_version = COALESCE($4, key_version),
           rotated_at = COALESCE($5, rotated_at),
           status = COALESCE($6, status),
           updated_at = now()
         WHERE tenant_id = $1 AND credentials_ref = $2 RETURNING *`,
        [tenant_id, credentials_ref,
         patch.encrypted_payload !== undefined ? patch.encrypted_payload : null,
         patch.key_version !== undefined ? patch.key_version : null,
         patch.rotated_at !== undefined ? new Date(patch.rotated_at) : null,
         patch.status !== undefined ? patch.status : null]
      );
      return r.rows[0] || null;
    },
    async setStatus(tenant_id, credentials_ref, status) { return this.updatePayload(tenant_id, credentials_ref, { status }); },
    async list(filter) {
      const t = filter && filter.tenant_id;
      const r = t ? await db.query('SELECT * FROM channel_credential_store WHERE tenant_id = $1', [t])
                  : await db.query('SELECT * FROM channel_credential_store', []);
      return r.rows;
    },
    async clear() { await db.query('DELETE FROM channel_credential_store', []); }
  };
}

module.exports = { buildChannelCredentialStoreDb };
