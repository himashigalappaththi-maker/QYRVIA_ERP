'use strict';

/**
 * DB implementations of the channel persistence contracts (Phase 24 B1/B4).
 *
 * DORMANT until CHANNEL_PERSISTENCE=db|dual. Each repo takes a `db` with a
 * `query(text, params) -> { rows }` method (pg Pool-compatible). SQL matches
 * migration 0045 column names exactly.
 *
 * NOTE (B4 wiring concern): production db-mode must route queries through a
 * tenant-scoped client (client.js withTenant -> SET app.tenant_id) so RLS
 * applies. This module keeps the raw-query interface so it is unit-testable with
 * a fake client; the tenant-scoping adapter is wired at activation time.
 */

function need(db) {
  if (!db || typeof db.query !== 'function') throw new Error('dbStores: db.query required');
  return db;
}

// ---- booking_store ---------------------------------------------------------
function buildBookingStoreDb({ db }) {
  need(db);
  return {
    async upsert(row) {
      // H5: Use INSERT ... ON CONFLICT DO NOTHING + fallback UPDATE to support the
      // new partial unique indexes (migration 0060) that include property_id scope.
      // The service-level rank/dedup check ensures only genuine advances reach here.
      const params = [row.tenant_id, row.property_id || null, row.channel, row.external_ref, row.status || null,
         row.guest_name || null, row.arrival || null, row.departure || null, row.room_type_id || null,
         row.amount != null ? row.amount : null, row.currency || null, row.source_channel || row.channel,
         row.payload_json || {}];
      let r = await db.query(
        `INSERT INTO channel_booking_store
           (tenant_id, property_id, channel, external_ref, status, guest_name, arrival, departure,
            room_type_id, amount, currency, source_channel, payload_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        params
      );
      if (!r.rows[0]) {
        // Conflict (existing row) — update status/payload and bump version
        r = await db.query(
          `UPDATE channel_booking_store
           SET status = $5, guest_name = $6, arrival = $7, departure = $8, room_type_id = $9,
               amount = $10, currency = $11, source_channel = $12, payload_json = $13,
               version = version + 1, updated_at = now()
           WHERE tenant_id = $1 AND property_id IS NOT DISTINCT FROM $2 AND channel = $3 AND external_ref = $4
           RETURNING *`,
          params
        );
      }
      return { accepted: true, item: r.rows[0] };
    },
    async getById(id) { const r = await db.query('SELECT * FROM channel_booking_store WHERE id = $1', [id]); return r.rows[0] || null; },
    async getByExternalRef(t, c, ref) {
      const r = await db.query('SELECT * FROM channel_booking_store WHERE tenant_id = $1 AND channel = $2 AND external_ref = $3', [t, c, ref]);
      return r.rows[0] || null;
    },
    async setPmsReservationId(id, resId) {
      const r = await db.query('UPDATE channel_booking_store SET pms_reservation_id = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, resId]);
      return r.rows[0] || null;
    },
    async list(filter) {
      if (filter && filter.tenant_id) { const r = await db.query('SELECT * FROM channel_booking_store WHERE tenant_id = $1 ORDER BY created_at', [filter.tenant_id]); return r.rows; }
      const r = await db.query('SELECT * FROM channel_booking_store ORDER BY created_at', []); return r.rows;
    },
    async clear() { await db.query('DELETE FROM channel_booking_store', []); }
  };
}

// ---- channel_mapping_store -------------------------------------------------
function buildChannelMappingStoreDb({ db }) {
  need(db);
  return {
    async upsertMapping(row) {
      const r = await db.query(
        `INSERT INTO channel_mapping_store
           (tenant_id, property_id, channel, enabled, credentials_ref, room_type_id, ota_room_id, ota_rate_plan_id, ota_property_id, mapping_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, property_id, channel, room_type_id) WHERE room_type_id IS NOT NULL
         DO UPDATE SET enabled = EXCLUDED.enabled, credentials_ref = EXCLUDED.credentials_ref,
                       ota_room_id = EXCLUDED.ota_room_id, ota_rate_plan_id = EXCLUDED.ota_rate_plan_id,
                       ota_property_id = EXCLUDED.ota_property_id, mapping_version = EXCLUDED.mapping_version, updated_at = now()
         RETURNING *`,
        [row.tenant_id, row.property_id || null, row.channel, row.enabled != null ? row.enabled : true,
         row.credentials_ref || null, row.room_type_id, row.ota_room_id || null, row.ota_rate_plan_id || null,
         row.ota_property_id || null, row.mapping_version != null ? row.mapping_version : 1]
      );
      return { accepted: true, item: r.rows[0] };
    },
    async getMapping(t, p, c, rt) {
      const r = await db.query('SELECT * FROM channel_mapping_store WHERE tenant_id = $1 AND property_id IS NOT DISTINCT FROM $2 AND channel = $3 AND room_type_id = $4', [t, p || null, c, rt]);
      return r.rows[0] || null;
    },
    async linkReservation(row) {
      const r = await db.query(
        `INSERT INTO channel_mapping_store (tenant_id, property_id, channel, reservation_id, external_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, reservation_id, channel) WHERE reservation_id IS NOT NULL
         DO UPDATE SET external_id = EXCLUDED.external_id, updated_at = now()
         RETURNING *`,
        [row.tenant_id, row.property_id || null, row.channel, row.reservation_id, row.external_id || null]
      );
      return { accepted: true, item: r.rows[0] };
    },
    async getReservationLink(t, r, c) {
      const res = await db.query('SELECT * FROM channel_mapping_store WHERE tenant_id = $1 AND reservation_id = $2 AND channel = $3', [t, r, c]);
      return res.rows[0] || null;
    },
    async list(filter) {
      const t = filter && filter.tenant_id;
      const res = t
        ? await db.query('SELECT * FROM channel_mapping_store WHERE tenant_id = $1', [t])
        : await db.query('SELECT * FROM channel_mapping_store', []);
      return res.rows;
    },
    async clear() { await db.query('DELETE FROM channel_mapping_store', []); }
  };
}

// ---- channel_sync_queue_store ---------------------------------------------
function buildSyncQueueStoreDb({ db }) {
  need(db);
  return {
    async enqueue(item) {
      // Partial-unique (PENDING) enforces dedupe; ON CONFLICT DO NOTHING -> deduped.
      const r = await db.query(
        `INSERT INTO channel_sync_queue_store (tenant_id, property_id, reservation_id, action, channel, payload_json, status)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING')
         ON CONFLICT (tenant_id, reservation_id, action) WHERE status = 'PENDING'
         DO NOTHING
         RETURNING *`,
        [item.tenant_id || null, item.property_id || null, item.reservation_id, item.action, item.channel || null, item.payload || item.payload_json || {}]
      );
      if (!r.rows[0]) return { accepted: false, deduped: true };
      return { accepted: true, item: r.rows[0] };
    },
    async dequeue() {
      const r = await db.query(
        `UPDATE channel_sync_queue_store SET status = 'PROCESSING', updated_at = now()
         WHERE id = (SELECT id FROM channel_sync_queue_store WHERE status = 'PENDING' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`, []);
      return r.rows[0] || null;
    },
    async markProcessing(id) { const r = await db.query("UPDATE channel_sync_queue_store SET status='PROCESSING', updated_at=now() WHERE id=$1 RETURNING *", [id]); return r.rows[0] || null; },
    async markCompleted(id)  { const r = await db.query("UPDATE channel_sync_queue_store SET status='COMPLETED', updated_at=now() WHERE id=$1 RETURNING *", [id]); return r.rows[0] || null; },
    async markFailed(id)     { const r = await db.query("UPDATE channel_sync_queue_store SET status='FAILED', attempts=attempts+1, updated_at=now() WHERE id=$1 RETURNING *", [id]); return r.rows[0] || null; },
    async get(id) { const r = await db.query('SELECT * FROM channel_sync_queue_store WHERE id = $1', [id]); return r.rows[0] || null; },
    async list(status) {
      const r = status
        ? await db.query('SELECT * FROM channel_sync_queue_store WHERE status = $1 ORDER BY created_at', [status])
        : await db.query('SELECT * FROM channel_sync_queue_store ORDER BY created_at', []);
      return r.rows;
    },
    async size() { const r = await db.query('SELECT count(*)::int AS n FROM channel_sync_queue_store', []); return r.rows[0] ? r.rows[0].n : 0; },
    async clear() { await db.query('DELETE FROM channel_sync_queue_store', []); }
  };
}

// ---- channel_dead_letter_store --------------------------------------------
function buildDeadLetterStoreDb({ db }) {
  need(db);
  return {
    async insert(rec) {
      const r = await db.query(
        `INSERT INTO channel_dead_letter_store (tenant_id, property_id, reservation_id, action, channel, payload_json, last_error, dedupe_generation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, reservation_id, action, dedupe_generation)
         DO UPDATE SET attempts = channel_dead_letter_store.attempts + 1,
                       last_error = COALESCE(EXCLUDED.last_error, channel_dead_letter_store.last_error), updated_at = now()
         RETURNING *`,
        [rec.tenant_id, rec.property_id || null, rec.reservation_id, rec.action, rec.channel || null,
         rec.payload_json || rec.payload || {}, rec.last_error || null, rec.dedupe_generation || 0]
      );
      return { accepted: true, item: r.rows[0] };
    },
    async get(id) { const r = await db.query('SELECT * FROM channel_dead_letter_store WHERE id = $1', [id]); return r.rows[0] || null; },
    async list(filter) {
      const t = filter && filter.tenant_id;
      const r = t ? await db.query('SELECT * FROM channel_dead_letter_store WHERE tenant_id = $1', [t])
                  : await db.query('SELECT * FROM channel_dead_letter_store', []);
      return r.rows;
    },
    async requestReprocess(id) { const r = await db.query('UPDATE channel_dead_letter_store SET reprocess_requested = TRUE, updated_at = now() WHERE id = $1 RETURNING *', [id]); return r.rows[0] || null; },
    async clear() { await db.query('DELETE FROM channel_dead_letter_store', []); }
  };
}

// ---- channel_sync_state_store ---------------------------------------------
function buildSyncStateStoreDb({ db }) {
  need(db);
  return {
    async upsert(row) {
      const r = await db.query(
        `INSERT INTO channel_sync_state_store (tenant_id, property_id, channel, resource_key, reservation_id, last_hash, last_status, last_error, last_sync_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, now()))
         ON CONFLICT (tenant_id, channel, resource_key)
         DO UPDATE SET last_hash = EXCLUDED.last_hash, last_status = EXCLUDED.last_status,
                       last_error = EXCLUDED.last_error, last_sync_at = EXCLUDED.last_sync_at,
                       reservation_id = EXCLUDED.reservation_id, updated_at = now()
         RETURNING *`,
        [row.tenant_id, row.property_id || null, row.channel, row.resource_key, row.reservation_id || null,
         row.last_hash || null, row.last_status || null, row.last_error || null, row.last_sync_at || null]
      );
      return { accepted: true, item: r.rows[0] };
    },
    async get(t, c, rk) { const r = await db.query('SELECT * FROM channel_sync_state_store WHERE tenant_id = $1 AND channel = $2 AND resource_key = $3', [t, c, rk]); return r.rows[0] || null; },
    async list(filter) {
      const t = filter && filter.tenant_id;
      const r = t ? await db.query('SELECT * FROM channel_sync_state_store WHERE tenant_id = $1', [t])
                  : await db.query('SELECT * FROM channel_sync_state_store', []);
      return r.rows;
    },
    async clear() { await db.query('DELETE FROM channel_sync_state_store', []); }
  };
}

// ---- channel_sync_lock_store (Fix 2) -----------------------------------------
function buildSyncLockStoreDb({ db }) {
  need(db);
  return {
    async acquire({ tenant_id, property_id, channel_code, lock_type, lock_holder, ttl_seconds = 300 }) {
      try {
        const r = await db.query(
          `INSERT INTO channel_sync_lock
             (tenant_id, property_id, channel_code, lock_type, lock_holder, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'running', now() + ($6 || ' seconds')::interval)
           RETURNING id`,
          [tenant_id, property_id || null, channel_code, lock_type, lock_holder || 'api', ttl_seconds]
        );
        return { ok: true, lockId: r.rows[0].id };
      } catch (e) {
        if (e.code === '23505') return { ok: false, error: 'lock_held' };
        throw e;
      }
    },
    async release(lockId) {
      await db.query(
        `UPDATE channel_sync_lock SET status = 'completed', updated_at = now() WHERE id = $1`,
        [lockId]
      );
    }
  };
}

// ---- channel_booking_import_log_store (Fix 3) --------------------------------
function buildImportLogStoreDb({ db }) {
  need(db);
  return {
    async insert(row) {
      await db.query(
        `INSERT INTO channel_booking_import_log
           (tenant_id, property_id, channel_code, external_booking_id, outcome, error_message)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.tenant_id, row.property_id || null, row.channel_code,
         row.external_booking_id || null, row.outcome, row.error_message || null]
      );
    }
  };
}

module.exports = {
  buildBookingStoreDb,
  buildChannelMappingStoreDb,
  buildSyncQueueStoreDb,
  buildDeadLetterStoreDb,
  buildSyncStateStoreDb,
  buildSyncLockStoreDb,
  buildImportLogStoreDb
};
