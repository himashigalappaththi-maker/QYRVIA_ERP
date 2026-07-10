'use strict';

/**
 * DB-backed OTA store (Phase 30.2) over migration 0050. Idempotent sync-attempt
 * recording (partial-unique on tenant+idempotency_key), drift persistence, and
 * per-channel transport health upsert. `db` is any { query } - a tenant-scoped
 * client in production so FORCE RLS binds.
 */

function buildOtaDbStore({ db } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('otaDbStore: db.query required');

  return {
    async recordAttempt({ tenant_id, propertyId = null, channel, op, status, attempts = 1, errorCode = null, idempotencyKey = null } = {}) {
      const r = await db.query(
        `INSERT INTO ota_sync_attempt (tenant_id, property_id, channel, op, status, attempts, error_code, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenant_id, propertyId, channel, op, status, attempts, errorCode, idempotencyKey]);
      return r.rows[0] ? { accepted: true, id: r.rows[0].id } : { accepted: false, deduped: true };
    },
    async listAttempts({ tenant_id, channel } = {}) {
      const r = channel
        ? await db.query('SELECT * FROM ota_sync_attempt WHERE tenant_id=$1 AND channel=$2 ORDER BY created_at', [tenant_id, channel])
        : await db.query('SELECT * FROM ota_sync_attempt WHERE tenant_id=$1 ORDER BY created_at', [tenant_id]);
      return r.rows;
    },
    async metrics(tenant_id, channel) {
      const r = await db.query(
        `SELECT count(*)::int total,
                count(*) FILTER (WHERE status='OK')::int ok,
                count(*) FILTER (WHERE status='FAILED')::int failed,
                COALESCE(sum(attempts - 1),0)::int retries
         FROM ota_sync_attempt WHERE tenant_id=$1 AND channel=$2`, [tenant_id, channel]);
      return r.rows[0];
    },
    async recordDrift(rows = []) {
      let inserted = 0;
      for (const d of rows) {
        await db.query(
          `INSERT INTO ota_drift (tenant_id, property_id, channel, drift_kind, mismatch_type, resource_key, local_value, remote_value, recommendation, severity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [d.tenant_id, d.property_id || null, d.channel, d.drift_kind, d.mismatch_type, d.resource_key, d.local_value || null, d.remote_value || null, d.recommendation || null, d.severity || 'warn']);
        inserted += 1;
      }
      return { inserted };
    },
    async listDrift({ tenant_id, channel } = {}) {
      const r = channel
        ? await db.query('SELECT * FROM ota_drift WHERE tenant_id=$1 AND channel=$2 ORDER BY detected_at', [tenant_id, channel])
        : await db.query('SELECT * FROM ota_drift WHERE tenant_id=$1 ORDER BY detected_at', [tenant_id]);
      return r.rows;
    },
    async upsertHealth({ tenant_id, channel, status, consecutiveFailures = 0, lastError = null } = {}) {
      const r = await db.query(
        `INSERT INTO ota_transport_health (tenant_id, channel, status, consecutive_failures, last_error, last_ok_at)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $4 = 0 THEN now() ELSE NULL END)
         ON CONFLICT (tenant_id, channel) DO UPDATE SET status=EXCLUDED.status, consecutive_failures=EXCLUDED.consecutive_failures,
           last_error=EXCLUDED.last_error,
           last_ok_at = CASE WHEN EXCLUDED.consecutive_failures = 0 THEN now() ELSE ota_transport_health.last_ok_at END,
           updated_at=now()
         RETURNING *`,
        [tenant_id, channel, status, consecutiveFailures, lastError]);
      return r.rows[0];
    },
    async getHealth(tenant_id, channel) {
      const r = await db.query('SELECT * FROM ota_transport_health WHERE tenant_id=$1 AND channel=$2', [tenant_id, channel]);
      return r.rows[0] || null;
    }
  };
}

module.exports = { buildOtaDbStore };
