'use strict';

/**
 * Repository implementations that talk to the real pg pool.
 * Tests use in-memory mocks with the same surface.
 *
 * Repositories are kept thin (no business rules). Tenant scoping is enforced
 * by the SQL queries themselves AND by RLS on the DB side (post-0004).
 */

const crypto = require('crypto');

function buildRepos(pool) {

  // ---- identity-repo --------------------------------------------------
  const identityRepo = {
    async findUserByTenantUsername(tenantCode, username) {
      const sql = `
        SELECT u.*, t.status AS tenant_status, t.id AS tenant_id_resolved
          FROM users u
          JOIN tenants t ON t.id = u.tenant_id
         WHERE t.code = $1 AND u.username = $2 AND u.soft_deleted_at IS NULL
         LIMIT 1`;
      const r = await pool.query(sql, [tenantCode, username]);
      return r.rows[0] || null;
    },

    async findUserByTenantUsernameById(tenantId, username) {
      const r = await pool.query(
        `SELECT * FROM users WHERE tenant_id = $1 AND username = $2 AND soft_deleted_at IS NULL LIMIT 1`,
        [tenantId, username]
      );
      return r.rows[0] || null;
    },

    // Phase 6 / C3: resolve a user by (property_code, username).
    // Joins properties (active) -> tenants -> users. Returns null if
    // the property is inactive or no matching user exists.
    async findUserByPropertyCodeUsername(propertyCode, username) {
      const sql = `
        SELECT u.*, t.status AS tenant_status, t.id AS tenant_id_resolved,
               p.id AS resolved_property_id, p.code AS resolved_property_code
          FROM properties p
          JOIN tenants t ON t.id = p.tenant_id
          JOIN users u ON u.tenant_id = t.id
         WHERE p.code = $1 AND u.username = $2
           AND u.soft_deleted_at IS NULL
           AND p.active = true
         LIMIT 1`;
      const r = await pool.query(sql, [propertyCode, username]);
      return r.rows[0] || null;
    },

    // Phase 6 / C2: list properties the user has any role at, plus the
    // user's primary_property_id (always included).
    async listAccessibleProperties(userId) {
      const sql = `
        WITH role_props AS (
          SELECT DISTINCT ur.property_id
            FROM user_roles ur
           WHERE ur.user_id = $1 AND ur.property_id IS NOT NULL
        ),
        scoped AS (
          SELECT p.id, p.code, p.name, p.tenant_id, p.active
            FROM properties p
           WHERE p.id IN (SELECT property_id FROM role_props)
              OR p.id = (SELECT primary_property_id FROM users WHERE id = $1)
        )
        SELECT s.id, s.code, s.name, s.tenant_id, s.active,
               COALESCE(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), ARRAY[]::text[]) AS role_codes
          FROM scoped s
          LEFT JOIN user_roles ur ON ur.user_id = $1 AND (ur.property_id = s.id OR ur.property_id IS NULL)
          LEFT JOIN roles r ON r.id = ur.role_id
         WHERE s.active = true
         GROUP BY s.id, s.code, s.name, s.tenant_id, s.active
         ORDER BY s.code`;
      const r = await pool.query(sql, [userId]);
      return r.rows;
    },

    // Phase 31.5: property authorization. True if the user may act on propertyId:
    // a role explicitly scoped to it, a tenant-wide role (property_id IS NULL =>
    // all properties of the company), or it being the user's primary property.
    // RLS additionally guarantees propertyId belongs to the user's tenant.
    async canAccessProperty(userId, propertyId) {
      const r = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM user_roles ur
            WHERE ur.user_id = $1 AND (ur.property_id = $2 OR ur.property_id IS NULL)
           UNION ALL
           SELECT 1 FROM users u
            WHERE u.id = $1 AND u.primary_property_id = $2
         ) AS ok`, [userId, propertyId]);
      return r.rows[0].ok === true;
    },

    async findUserById(id) {
      const r = await pool.query(`SELECT * FROM users WHERE id = $1 AND soft_deleted_at IS NULL LIMIT 1`, [id]);
      return r.rows[0] || null;
    },

    async findRolesForUser(userId) {
      const sql = `
        SELECT r.id, r.code, r.scope, ur.property_id
          FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1`;
      const r = await pool.query(sql, [userId]);
      return r.rows;
    },

    async findPermissionsForUser(userId) {
      const sql = `
        SELECT DISTINCT p.code
          FROM user_roles ur
          JOIN role_permissions rp ON rp.role_id = ur.role_id
          JOIN permissions p      ON p.id = rp.permission_id
         WHERE ur.user_id = $1`;
      const r = await pool.query(sql, [userId]);
      return r.rows.map((x) => x.code);
    },

    // Phase 21: read-only IAM listings (no RBAC change). Never returns password_hash.
    async listUsers(tenantId) {
      const r = await pool.query(
        `SELECT id, tenant_id, username, email, full_name, primary_property_id,
                status, last_login_at, locked_until, created_at
           FROM users
          WHERE tenant_id = $1 AND soft_deleted_at IS NULL
          ORDER BY username
          LIMIT 500`,
        [tenantId]
      );
      return r.rows;
    },
    async listRoles() {
      const r = await pool.query(
        `SELECT id, code, name, description, scope, is_system FROM roles ORDER BY code`
      );
      return r.rows;
    },

    async updateUserOnSuccessfulLogin(userId) {
      await pool.query(
        `UPDATE users
            SET last_login_at = now(),
                failed_login_count = 0,
                locked_until = NULL,
                updated_at = now()
          WHERE id = $1`,
        [userId]
      );
    },

    async updateUserOnFailedLogin(userId) {
      // 5 strikes -> lock for 15 minutes
      await pool.query(
        `UPDATE users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE
                  WHEN failed_login_count + 1 >= 5 THEN now() + INTERVAL '15 minutes'
                  ELSE locked_until END,
                status = CASE
                  WHEN failed_login_count + 1 >= 5 THEN 'LOCKED'::user_status
                  ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [userId]
      );
    },

    async insertUser(rec) {
      const r = await pool.query(
        `INSERT INTO users (tenant_id, username, email, password_hash, full_name, primary_property_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [rec.tenant_id, rec.username, rec.email, rec.password_hash, rec.full_name, rec.primary_property_id, rec.status]
      );
      return r.rows[0];
    },

    async insertUserRoleByCode({ user_id, role_code, tenant_id, property_id, granted_by }) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id, tenant_id, property_id, granted_by)
         SELECT $1, r.id, $2, $3, $4 FROM roles r WHERE r.code = $5
         ON CONFLICT DO NOTHING`,
        [user_id, tenant_id, property_id, granted_by, role_code]
      );
    },

    async findPropertyBusinessDate(propertyId) {
      const r = await pool.query(
        `SELECT current_business_date, business_date_locked FROM properties WHERE id = $1 LIMIT 1`,
        [propertyId]
      );
      return r.rows[0] || null;
    },

    // Phase 57: global email lookup for SaaS email-based login.
    // Tenant is unknown at login time when only email+password are supplied;
    // this intentionally bypasses the per-tenant RLS filter by running on the
    // unrestricted app pool (same pattern as findUserByTenantUsername above).
    async findUserByEmailGlobal(email) {
      const sql = `
        SELECT u.*, t.status AS tenant_status
          FROM users u
          JOIN tenants t ON t.id = u.tenant_id
         WHERE lower(u.email) = lower($1)
           AND u.soft_deleted_at IS NULL
         LIMIT 1`;
      const r = await pool.query(sql, [String(email).trim()]);
      return r.rows[0] || null;
    }
  };

  // ---- tokens repo ----------------------------------------------------
  const tokensRepo = {
    async insertRefreshToken(rec) {
      const r = await pool.query(
        `INSERT INTO refresh_tokens
           (user_id, tenant_id, token_hash, device_name, device_id, ip_address, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [rec.user_id, rec.tenant_id, rec.token_hash, rec.device_name, rec.device_id, rec.ip_address, rec.user_agent, rec.expires_at]
      );
      return r.rows[0];
    },

    async findRefreshTokenByHash(hash) {
      const r = await pool.query(`SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`, [hash]);
      return r.rows[0] || null;
    },

    async markRefreshTokenUsed(id, ts) {
      await pool.query(`UPDATE refresh_tokens SET last_used_at = $2 WHERE id = $1`, [id, ts]);
    },

    async revokeRefreshToken(id, ts) {
      await pool.query(`UPDATE refresh_tokens SET revoked_at = $2 WHERE id = $1`, [id, ts]);
    },

    async revokeChainFrom(id, ts) {
      // Revoke the row + everything it rotated to (transitive)
      await pool.query(
        `WITH RECURSIVE chain AS (
           SELECT id FROM refresh_tokens WHERE id = $1
           UNION ALL
           SELECT rt.id FROM refresh_tokens rt JOIN chain c ON rt.id = c.id  -- single row guarded
         ) UPDATE refresh_tokens SET revoked_at = $2 WHERE id IN (SELECT id FROM chain)`,
        [id, ts]
      );
      // Also walk forward via rotated_to
      await pool.query(
        `WITH RECURSIVE forward AS (
           SELECT id, rotated_to FROM refresh_tokens WHERE id = $1
           UNION ALL
           SELECT rt.id, rt.rotated_to FROM refresh_tokens rt JOIN forward f ON rt.id = f.rotated_to
         ) UPDATE refresh_tokens SET revoked_at = $2 WHERE id IN (SELECT id FROM forward) AND revoked_at IS NULL`,
        [id, ts]
      );
    },

    async linkRotation(oldId, newId) {
      await pool.query(`UPDATE refresh_tokens SET rotated_to = $2 WHERE id = $1`, [oldId, newId]);
    },

    // Phase 57: revoke all active refresh tokens for a user (e.g. after password reset).
    async revokeAllRefreshTokensForUser(userId) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
    }
  };

  // ---- settings repo -------------------------------------------------
  const settingsRepo = {
    async findSetting(tenantId, propertyId, category, key) {
      const sql = propertyId
        ? `SELECT * FROM settings WHERE tenant_id=$1 AND property_id=$2 AND category=$3 AND key=$4 LIMIT 1`
        : `SELECT * FROM settings WHERE tenant_id=$1 AND property_id IS NULL AND category=$2 AND key=$3 LIMIT 1`;
      const params = propertyId ? [tenantId, propertyId, category, key] : [tenantId, category, key];
      const r = await pool.query(sql, params);
      return r.rows[0] || null;
    },
    async upsertSetting({ tenant_id, property_id, category, key, value_json, updated_by }) {
      const sentinel = '00000000-0000-0000-0000-000000000000';
      const r = await pool.query(
        `INSERT INTO settings (tenant_id, property_id, category, key, value_json, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (tenant_id, COALESCE(property_id, '${sentinel}'::uuid), category, key)
         DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [tenant_id, property_id, category, key, value_json, updated_by]
      );
      return r.rows[0];
    },
    async listSettings(tenantId, category) {
      const sql = category
        ? `SELECT * FROM settings WHERE tenant_id=$1 AND category=$2 ORDER BY category, key`
        : `SELECT * FROM settings WHERE tenant_id=$1 ORDER BY category, key`;
      const r = await pool.query(sql, category ? [tenantId, category] : [tenantId]);
      return r.rows;
    },
    async deleteSetting(tenantId, propertyId, category, key) {
      const sql = propertyId
        ? `DELETE FROM settings WHERE tenant_id=$1 AND property_id=$2 AND category=$3 AND key=$4`
        : `DELETE FROM settings WHERE tenant_id=$1 AND property_id IS NULL AND category=$2 AND key=$3`;
      const params = propertyId ? [tenantId, propertyId, category, key] : [tenantId, category, key];
      const r = await pool.query(sql, params);
      return r.rowCount;
    }
  };

  // ---- file repo -----------------------------------------------------
  const fileRepo = {
    async insertFile(rec) {
      const r = await pool.query(
        `INSERT INTO files (tenant_id, property_id, file_name, mime_type, file_size, sha256, storage_provider, storage_key, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.file_name, rec.mime_type, rec.file_size, rec.sha256, rec.storage_provider, rec.storage_key, rec.uploaded_by]
      );
      return r.rows[0];
    },
    async findFileById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM files WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async softDeleteFile(tenantId, id) {
      const r = await pool.query(
        `UPDATE files SET status='deleted'::file_status, deleted_at=now() WHERE tenant_id=$1 AND id=$2`,
        [tenantId, id]
      );
      return r.rowCount > 0;
    }
  };

  // ---- connector repo ------------------------------------------------
  const connectorRepo = {
    async listConnectors() {
      const r = await pool.query(`SELECT id, code, label, type, is_active FROM connectors WHERE is_active=true ORDER BY type, code`);
      return r.rows;
    },
    async findConnectorByCode(code) {
      const r = await pool.query(`SELECT id, code, label, type FROM connectors WHERE code=$1 LIMIT 1`, [code]);
      return r.rows[0] || null;
    },
    async findConnectorConfig(tenantId, propertyId, code) {
      const sql = propertyId
        ? `SELECT cc.* FROM connector_configs cc JOIN connectors c ON c.id = cc.connector_id WHERE cc.tenant_id=$1 AND cc.property_id=$2 AND c.code=$3 LIMIT 1`
        : `SELECT cc.* FROM connector_configs cc JOIN connectors c ON c.id = cc.connector_id WHERE cc.tenant_id=$1 AND cc.property_id IS NULL AND c.code=$2 LIMIT 1`;
      const params = propertyId ? [tenantId, propertyId, code] : [tenantId, code];
      const r = await pool.query(sql, params);
      return r.rows[0] || null;
    },
    async upsertConnectorConfig(rec) {
      const sentinel = '00000000-0000-0000-0000-000000000000';
      const r = await pool.query(
        `INSERT INTO connector_configs (tenant_id, property_id, connector_id, enabled, config_json, configured_by, configured_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (tenant_id, COALESCE(property_id, '${sentinel}'::uuid), connector_id)
         DO UPDATE SET enabled=EXCLUDED.enabled, config_json=EXCLUDED.config_json, configured_by=EXCLUDED.configured_by, configured_at=now()
         RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.connector_id, rec.enabled, rec.config_json, rec.configured_by]
      );
      return r.rows[0];
    },
    async insertConnectorHealthLog({ tenant_id, connector_id, kind, status, detail, latency_ms }) {
      await pool.query(
        `INSERT INTO connector_health_log (tenant_id, connector_id, kind, status, detail, latency_ms)
         VALUES ($1,$2,$3,$4::connector_health_status,$5,$6)`,
        [tenant_id, connector_id, kind, status, detail, latency_ms]
      );
    }
  };

  // ---- scheduler repo -------------------------------------------------
  const schedulerRepo = {
    async insertScheduledJob(rec) {
      const r = await pool.query(
        `INSERT INTO scheduled_jobs (tenant_id, property_id, job_type, payload, run_at, max_attempts, created_by, recurrence_rule, timezone, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.job_type, rec.payload, rec.run_at, rec.max_attempts, rec.created_by,
         rec.recurrence_rule || null, rec.timezone || 'UTC', rec.next_run_at || null]
      );
      return r.rows[0];
    },
    async cancelScheduledJob(id) {
      const r = await pool.query(
        `UPDATE scheduled_jobs SET status='cancelled'::scheduled_job_status WHERE id=$1 AND status='pending'`,
        [id]
      );
      return r.rowCount > 0;
    },
    async claimDueJobs({ workerId, limit }) {
      const r = await pool.query(
        `WITH due AS (
           SELECT id FROM scheduled_jobs
            WHERE status='pending' AND run_at <= now()
            ORDER BY run_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE scheduled_jobs sj
            SET status='running'::scheduled_job_status,
                locked_by=$2, locked_at=now(), started_at=now(),
                attempts=sj.attempts+1
           FROM due
          WHERE sj.id = due.id
       RETURNING sj.*`,
        [limit, workerId]
      );
      return r.rows;
    },
    async markJobCompleted(id) {
      await pool.query(
        `UPDATE scheduled_jobs SET status='completed'::scheduled_job_status, completed_at=now() WHERE id=$1`,
        [id]
      );
    },
    async markJobCompletedAndReschedule(id, nextRunAt) {
      // Recurring job: log this run as completed, then reset row to pending @ next time.
      await pool.query(
        `UPDATE scheduled_jobs
            SET status='pending'::scheduled_job_status,
                run_at=$2,
                next_run_at=$2,
                attempts=0,
                last_error=NULL,
                locked_by=NULL, locked_at=NULL,
                started_at=NULL, completed_at=NULL
          WHERE id=$1`,
        [id, nextRunAt]
      );
    },
    async markJobFailed(id, error, final, finalState) {
      // finalState: 'failed' | 'dead_letter' when final; 'pending' otherwise.
      const status = final ? (finalState || 'failed') : 'pending';
      await pool.query(
        `UPDATE scheduled_jobs
            SET status=$2::scheduled_job_status,
                last_error=$3,
                locked_by=NULL, locked_at=NULL,
                dead_letter_reason=CASE WHEN $2='dead_letter' THEN $3 ELSE dead_letter_reason END,
                completed_at=CASE WHEN $2 IN ('failed','dead_letter') THEN now() ELSE NULL END
          WHERE id=$1`,
        [id, status, String(error || '').slice(0, 2000)]
      );
    }
  };

  // ---- notifications repo --------------------------------------------
  const notificationRepo = {
    async findActiveTemplate(tenantId, code, channel) {
      const r = await pool.query(
        `SELECT * FROM notification_templates WHERE tenant_id=$1 AND code=$2 AND channel=$3::notification_channel AND is_active=true LIMIT 1`,
        [tenantId, code, channel]
      );
      return r.rows[0] || null;
    },
    // Client required on all paths. Returns { row, created }.
    // When source_idempotency_key is set the insert is atomic: ON CONFLICT
    // against the partial unique index does nothing and the existing row is
    // fetched with the same client.  When source_idempotency_key is NULL the
    // ON CONFLICT clause never fires (partial index does not cover NULL rows).
    async insertNotification(rec, client) {
      this._requireClient(client);
      const r = await client.query(
        `INSERT INTO notifications
           (tenant_id, property_id, channel, template_code, recipient, subject, body,
            context, status, requested_by,
            encrypted_payload, encryption_iv, encryption_tag,
            encryption_payload_version, encryption_key_version, source_idempotency_key)
         VALUES ($1,$2,$3::notification_channel,$4,$5,$6,$7,$8,$9::notification_status,$10,
                 $11,$12,$13,$14,$15,$16)
         ON CONFLICT (tenant_id, source_idempotency_key)
           WHERE source_idempotency_key IS NOT NULL
           DO NOTHING
         RETURNING *`,
        [rec.tenant_id, rec.property_id || null, rec.channel, rec.template_code || null,
         rec.recipient, rec.subject, rec.body, rec.context || {},
         rec.status || 'pending', rec.requested_by || null,
         rec.encrypted_payload || null, rec.encryption_iv || null, rec.encryption_tag || null,
         rec.encryption_payload_version || null, rec.encryption_key_version || null,
         rec.source_idempotency_key || null]
      );
      if (r.rows[0]) return { row: r.rows[0], created: true };
      // Conflict — return the existing row using the same tenant-scoped client.
      const existing = await client.query(
        `SELECT * FROM notifications WHERE tenant_id=$1 AND source_idempotency_key=$2 LIMIT 1`,
        [rec.tenant_id, rec.source_idempotency_key]
      );
      return { row: existing.rows[0], created: false };
    },
    async findNotificationById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM notifications WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      if (!r.rows[0]) return null;
      const logs = await pool.query(`SELECT * FROM notification_delivery_log WHERE notification_id=$1 ORDER BY attempt_no`, [id]);
      return Object.assign({}, r.rows[0], { delivery_log: logs.rows });
    },
    async listNotifications(tenantId, status, limit) {
      const sql = status
        ? `SELECT * FROM notifications WHERE tenant_id=$1 AND status=$2::notification_status ORDER BY requested_at DESC LIMIT $3`
        : `SELECT * FROM notifications WHERE tenant_id=$1 ORDER BY requested_at DESC LIMIT $2`;
      const params = status ? [tenantId, status, limit || 100] : [tenantId, limit || 100];
      const r = await pool.query(sql, params);
      return r.rows;
    },
    _requireClient(client) {
      if (!client) throw Object.assign(
        new Error('notificationRepo: tenant-scoped DB client required'),
        { code: 'NOTIFICATION_CLIENT_REQUIRED' }
      );
    },
    // Phase 58: atomic claim with stale-lease recovery and attempt ceiling.
    // Only claim rows where attempt_count < max_attempts (avoids re-queuing
    // permanently failed notifications whose attempt ceiling was already raised
    // externally). Does NOT increment attempt_count — that is done in
    // beginNotificationAttempt immediately before the real provider send.
    async claimPendingNotifications({ workerId, limit = 25, leaseMinutes = 10 }, client) {
      this._requireClient(client);
      if (!workerId) throw Object.assign(
        new Error('claimPendingNotifications: workerId required'), { code: 'INVALID_INPUT' }
      );
      const safeLimit = Math.max(1, Math.min(100, Number(limit)      || 25));
      const safeLease = Math.max(1, Math.min(1440, Number(leaseMinutes) || 10));
      const r = await client.query(
        `WITH due AS (
           SELECT id FROM notifications
            WHERE (status = 'pending'
                   AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                   AND attempt_count < max_attempts)
               OR (status = 'sending'
                   AND locked_at < now() - ($3::text || ' minutes')::interval
                   AND attempt_count < max_attempts)
            ORDER BY requested_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         UPDATE notifications n
            SET status    = 'sending'::notification_status,
                locked_by = $1,
                locked_at = now()
           FROM due WHERE n.id = due.id
         RETURNING n.*`,
        [workerId, safeLimit, safeLease]
      );
      return r.rows;
    },
    // Increment attempt_count exactly once immediately before a real provider send.
    // Persists the idempotency key only when the column is currently NULL.
    // Returns null (no-op) when a different key already exists — prevents
    // double-increment on replay. Also guards status, ownership, and ceiling.
    async beginNotificationAttempt(id, workerId, providerIdempotencyKey, client) {
      this._requireClient(client);
      const r = await client.query(
        `UPDATE notifications
            SET attempt_count            = attempt_count + 1,
                provider_idempotency_key = COALESCE(provider_idempotency_key, $3)
          WHERE id           = $1
            AND status       = 'sending'
            AND locked_by    = $2
            AND attempt_count < max_attempts
            AND (provider_idempotency_key IS NULL OR provider_idempotency_key = $3)
          RETURNING *`,
        [id, workerId, providerIdempotencyKey || null]
      );
      return r.rows[0] || null;
    },
    // Atomically transition to 'delivered'. Ownership + attempt count both checked
    // to prevent a stale worker overwriting a row reclaimed by another.
    // Clears all encrypted-payload columns atomically — no residue after delivery.
    async markNotificationDelivered(id, workerId, expectedAttemptCount, providerMessageId, client) {
      this._requireClient(client);
      const r = await client.query(
        `UPDATE notifications
            SET status                    = 'delivered'::notification_status,
                completed_at              = now(),
                provider_message_id       = $4,
                next_attempt_at           = NULL,
                locked_by                 = NULL,
                locked_at                 = NULL,
                encrypted_payload         = NULL,
                encryption_iv             = NULL,
                encryption_tag            = NULL,
                encryption_key_version    = NULL,
                encryption_payload_version = NULL
          WHERE id            = $1
            AND status        = 'sending'
            AND locked_by     = $2
            AND attempt_count = $3
          RETURNING *`,
        [id, workerId, expectedAttemptCount, providerMessageId || null]
      );
      return r.rows[0] || null;
    },
    // Return to pending with a backoff schedule. Attempt count is NOT changed here.
    // Will only match rows still owned by this worker at this attempt count,
    // and only when retries remain (attempt_count < max_attempts).
    async markNotificationRetry(id, workerId, expectedAttemptCount, nextAttemptAt, client) {
      this._requireClient(client);
      const r = await client.query(
        `UPDATE notifications
            SET status          = 'pending'::notification_status,
                next_attempt_at = $4::timestamptz,
                completed_at    = NULL,
                locked_by       = NULL,
                locked_at       = NULL
          WHERE id            = $1
            AND status        = 'sending'
            AND locked_by     = $2
            AND attempt_count = $3
            AND attempt_count < max_attempts
          RETURNING *`,
        [id, workerId, expectedAttemptCount, nextAttemptAt]
      );
      return r.rows[0] || null;
    },
    // Terminal failure. Only permitted when attempt_count >= max_attempts OR
    // failureClass='permanent' (e.g. invalid recipient, undeliverable).
    // Attempt count is intentionally not altered — it is already at the ceiling.
    // Clears all encrypted-payload columns atomically — no residue after terminal failure.
    async markNotificationFailed(id, workerId, expectedAttemptCount, failureClass, client) {
      this._requireClient(client);
      const r = await client.query(
        `UPDATE notifications
            SET status                    = 'failed'::notification_status,
                completed_at              = now(),
                next_attempt_at           = NULL,
                locked_by                 = NULL,
                locked_at                 = NULL,
                encrypted_payload         = NULL,
                encryption_iv             = NULL,
                encryption_tag            = NULL,
                encryption_key_version    = NULL,
                encryption_payload_version = NULL
          WHERE id            = $1
            AND status        = 'sending'
            AND locked_by     = $2
            AND attempt_count = $3
            AND (attempt_count >= max_attempts OR $4 = 'permanent')
          RETURNING *`,
        [id, workerId, expectedAttemptCount, failureClass || 'exhausted']
      );
      return r.rows[0] || null;
    },
    // Legacy: used by non-retry flows (no-provider / not_configured path) and
    // existing callers predating Phase 58.  NOT permitted for use by the Phase 58
    // retry worker — use the explicit transition methods above instead.
    async markNotificationStatus(id, status) {
      await pool.query(
        `UPDATE notifications SET status=$2::notification_status, completed_at=CASE WHEN $2 IN ('delivered','failed','not_configured','cancelled') THEN now() ELSE NULL END WHERE id=$1`,
        [id, status]
      );
    },
    async insertDeliveryLog({ notification_id, tenant_id, attempt_no, status, provider, provider_ref, error, error_code }) {
      await pool.query(
        `INSERT INTO notification_delivery_log (notification_id, tenant_id, attempt_no, status, provider, provider_ref, error)
         VALUES ($1,$2,$3,$4::notification_status,$5,$6,$7)`,
        [notification_id, tenant_id, attempt_no, status, provider, provider_ref, error_code || error || null]
      );
    },
    async nextAttemptNo(notificationId) {
      const r = await pool.query(
        `SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM notification_delivery_log WHERE notification_id=$1`,
        [notificationId]
      );
      return r.rows[0].n;
    }
  };

  // ---- confirmationDeliveryRepo (Phase 56) --------------------------------
  const confirmationDeliveryRepo = {
    async insertBookingConfirmationDelivery(rec) {
      const r = await pool.query(
        `INSERT INTO booking_confirmation_deliveries
           (tenant_id, property_id, reservation_id, confirmation_number,
            channel, recipient, notification_type, context, dedup_key,
            max_attempts)
         VALUES ($1,$2,$3,$4,$5::notification_channel,$6,$7,$8,$9,$10)
         RETURNING *`,
        [rec.tenant_id, rec.property_id || null, rec.reservation_id,
         rec.confirmation_number || null, rec.channel, rec.recipient,
         rec.notification_type || 'booking_confirmation',
         rec.context ? JSON.stringify(rec.context) : '{}',
         rec.dedup_key, rec.max_attempts || 3]
      );
      return r.rows[0];
    },
    async claimPendingConfirmationDeliveries({ limit = 25, workerId }) {
      const r = await pool.query(
        `WITH due AS (
           SELECT id FROM booking_confirmation_deliveries
            WHERE status = 'pending'
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            ORDER BY created_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE booking_confirmation_deliveries d
            SET status    = 'processing',
                locked_by = $2,
                locked_at = now(),
                updated_at = now()
           FROM due WHERE d.id = due.id
         RETURNING d.*`,
        [limit, workerId || null]
      );
      return r.rows;
    },
    async markConfirmationDeliveryStatus(id, status, { sentAt, providerRef, attemptCount, lastError, nextAttemptAt } = {}) {
      // When nextAttemptAt is set and the logical status is retryable_failure, the row
      // reverts to 'pending' so the worker's next poll picks it up on schedule.
      const effectiveStatus = (nextAttemptAt && status === 'retryable_failure')
        ? 'pending' : status;
      await pool.query(
        `UPDATE booking_confirmation_deliveries
            SET status          = $2::booking_confirmation_delivery_status,
                locked_by       = NULL,
                locked_at       = NULL,
                updated_at      = now(),
                sent_at         = COALESCE($3, sent_at),
                provider_ref    = COALESCE($4, provider_ref),
                attempt_count   = COALESCE($5, attempt_count),
                last_error      = COALESCE($6, last_error),
                next_attempt_at = $7
          WHERE id = $1`,
        [id, effectiveStatus, sentAt || null, providerRef || null,
         attemptCount != null ? attemptCount : null,
         lastError || null, nextAttemptAt || null]
      );
    },
    async findConfirmationDeliveryByDedupKey(tenantId, dedupKey) {
      const r = await pool.query(
        `SELECT * FROM booking_confirmation_deliveries WHERE tenant_id=$1 AND dedup_key=$2 LIMIT 1`,
        [tenantId, dedupKey]
      );
      return r.rows[0] || null;
    },
  };

  // ---- webhook repo --------------------------------------------------
  const webhookRepo = {
    async insertWebhookEndpoint(rec) {
      const r = await pool.query(
        `INSERT INTO webhook_endpoints (tenant_id, property_id, name, url, secret, event_types, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.name, rec.url, rec.secret, rec.event_types, rec.created_by]
      );
      return r.rows[0];
    },
    async listWebhookEndpoints(tenantId) {
      const r = await pool.query(`SELECT * FROM webhook_endpoints WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
      return r.rows;
    },
    async disableWebhookEndpoint(tenantId, id) {
      const r = await pool.query(
        `UPDATE webhook_endpoints SET is_active=false, disabled_at=now() WHERE tenant_id=$1 AND id=$2 AND is_active=true`,
        [tenantId, id]
      );
      return r.rowCount > 0;
    },
    async findWebhookEndpoint(id) {
      const r = await pool.query(`SELECT * FROM webhook_endpoints WHERE id=$1 LIMIT 1`, [id]);
      return r.rows[0] || null;
    },
    async listActiveEndpointsForEvent(tenantId, eventType) {
      // empty event_types = subscribe to all
      const r = await pool.query(
        `SELECT * FROM webhook_endpoints
          WHERE tenant_id=$1 AND is_active=true
            AND (cardinality(event_types) = 0 OR $2 = ANY(event_types))`,
        [tenantId, eventType]
      );
      return r.rows;
    },
    async insertWebhookDelivery(rec) {
      const r = await pool.query(
        `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, signature)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [rec.tenant_id, rec.endpoint_id, rec.event_id, rec.event_type, rec.payload, rec.signature]
      );
      return r.rows[0];
    },
    async claimDueWebhookDeliveries({ limit }) {
      const r = await pool.query(
        `WITH due AS (
           SELECT id FROM webhook_deliveries
            WHERE status IN ('pending','failed') AND next_attempt_at <= now() AND attempts < max_attempts
            ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE webhook_deliveries d
            SET status='sending'::webhook_delivery_status, attempts = d.attempts + 1
           FROM due WHERE d.id = due.id RETURNING d.*`,
        [limit]
      );
      return r.rows;
    },
    async markWebhookDelivered(id, statusCode) {
      await pool.query(
        `UPDATE webhook_deliveries SET status='delivered'::webhook_delivery_status, delivered_at=now(), last_status_code=$2 WHERE id=$1`,
        [id, statusCode]
      );
    },
    async markWebhookFailed(id, error, statusCode, nextAttemptAt, final) {
      const status = final ? 'failed' : 'pending';
      await pool.query(
        `UPDATE webhook_deliveries
            SET status=$2::webhook_delivery_status,
                last_error=$3,
                last_status_code=$4,
                next_attempt_at=COALESCE($5::timestamptz, next_attempt_at)
          WHERE id=$1`,
        [id, status, String(error || '').slice(0, 2000), statusCode, nextAttemptAt]
      );
    }
  };

  // ---- aggregate store repo (Phase 4) --------------------------------
  const aggregateRepo = {
    async findLatestSnapshot(tenantId, aggregateType, aggregateId) {
      const r = await pool.query(
        `SELECT * FROM aggregate_snapshots WHERE tenant_id=$1 AND aggregate_type=$2 AND aggregate_id=$3 LIMIT 1`,
        [tenantId, aggregateType, aggregateId]
      );
      return r.rows[0] || null;
    },
    async listAggregateEvents(tenantId, aggregateType, aggregateId, sinceVersion) {
      const r = await pool.query(
        `SELECT id AS event_id, event_type, event_version, payload_json, occurred_at
           FROM event_store
          WHERE tenant_id=$1 AND aggregate_type=$2 AND aggregate_id=$3 AND event_version > $4
          ORDER BY event_version`,
        [tenantId, aggregateType, aggregateId, sinceVersion || 0]
      );
      return r.rows.map((row) => Object.assign(row, { payload: row.payload_json }));
    },
    async getCurrentVersion(tenantId, aggregateType, aggregateId) {
      const r = await pool.query(
        `SELECT COALESCE(MAX(event_version),0) AS v
           FROM event_store
          WHERE tenant_id=$1 AND aggregate_type=$2 AND aggregate_id=$3`,
        [tenantId, aggregateType, aggregateId]
      );
      return parseInt(r.rows[0].v, 10);
    },
    async appendEventWithVersion(rec) {
      // Single INSERT - the unique index on (tenant_id, aggregate_type, aggregate_id, event_version)
      // enforces optimistic concurrency.
      await pool.query(
        `INSERT INTO event_store
           (id, tenant_id, property_id, aggregate_type, aggregate_id,
            event_type, event_version, payload_json, actor_id, request_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [rec.event_id, rec.tenant_id, rec.property_id, rec.aggregate_type, rec.aggregate_id,
         rec.event_type, rec.event_version, rec.payload_json, rec.actor_id, rec.request_id, rec.occurred_at]
      );
    },
    async upsertSnapshot(rec) {
      await pool.query(
        `INSERT INTO aggregate_snapshots
           (tenant_id, aggregate_type, aggregate_id, aggregate_version, snapshot_json)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, aggregate_type, aggregate_id)
         DO UPDATE SET aggregate_version=EXCLUDED.aggregate_version,
                       snapshot_json=EXCLUDED.snapshot_json,
                       created_at=now()`,
        [rec.tenant_id, rec.aggregate_type, rec.aggregate_id, rec.aggregate_version, rec.snapshot_json]
      );
    }
  };

  // ---- PMS repos (Phase 5) -------------------------------------------
  const pmsRepo = {
    // ----- room_types -----
    async insertRoomType(rec) {
      const r = await pool.query(
        `INSERT INTO room_types (tenant_id, property_id, code, name, description,
            max_adults, max_children, base_occupancy, extra_bed_capacity, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.code, rec.name, rec.description || null,
         rec.max_adults, rec.max_children, rec.base_occupancy, rec.extra_bed_capacity,
         rec.active !== false, rec.created_by]
      );
      return r.rows[0];
    },
    async findRoomTypeById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM room_types WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async findRoomTypeByCode(tenantId, propertyId, code) {
      const r = await pool.query(`SELECT * FROM room_types WHERE tenant_id=$1 AND property_id=$2 AND code=$3 LIMIT 1`, [tenantId, propertyId, code]);
      return r.rows[0] || null;
    },
    async listRoomTypes(tenantId, propertyId) {
      const r = await pool.query(`SELECT * FROM room_types WHERE tenant_id=$1 AND property_id=$2 ORDER BY code`, [tenantId, propertyId]);
      return r.rows;
    },

    // ----- buildings + floors -----
    async insertBuilding(rec) {
      const r = await pool.query(
        `INSERT INTO buildings (tenant_id, property_id, code, name, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.code, rec.name, rec.active !== false, rec.created_by]
      );
      return r.rows[0];
    },
    async listBuildings(tenantId, propertyId) {
      const r = await pool.query(`SELECT * FROM buildings WHERE tenant_id=$1 AND property_id=$2 ORDER BY code`, [tenantId, propertyId]);
      return r.rows;
    },
    async insertFloor(rec) {
      const r = await pool.query(
        `INSERT INTO floors (tenant_id, property_id, building_id, code, name, active)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.building_id, rec.code, rec.name, rec.active !== false]
      );
      return r.rows[0];
    },
    async listFloors(tenantId, buildingId) {
      const r = await pool.query(`SELECT * FROM floors WHERE tenant_id=$1 AND building_id=$2 ORDER BY code`, [tenantId, buildingId]);
      return r.rows;
    },

    // ----- rooms -----
    async insertRoom(rec) {
      const r = await pool.query(
        `INSERT INTO rooms (tenant_id, property_id, building_id, floor_id, room_type_id,
            room_number, room_name, status, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.building_id || null, rec.floor_id || null,
         rec.room_type_id, rec.room_number, rec.room_name || null,
         rec.status || 'VACANT_CLEAN', rec.active !== false, rec.created_by]
      );
      return r.rows[0];
    },
    async findRoomById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM rooms WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async findRoomByNumber(tenantId, propertyId, number) {
      const r = await pool.query(`SELECT * FROM rooms WHERE tenant_id=$1 AND property_id=$2 AND room_number=$3 LIMIT 1`, [tenantId, propertyId, number]);
      return r.rows[0] || null;
    },
    async listRooms(tenantId, propertyId, opts = {}) {
      const params = [tenantId, propertyId];
      let sql = `SELECT r.*, rt.code AS room_type_code FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id WHERE r.tenant_id=$1 AND r.property_id=$2`;
      if (opts.activeOnly) sql += ` AND r.active = true`;
      sql += ` ORDER BY r.room_number`;
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async listRoomsForAvailability({ tenantId, propertyId, roomTypeId }) {
      let sql = `SELECT r.id, r.room_number, r.status, r.active, r.room_type_id, rt.code AS room_type_code
                   FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
                  WHERE r.tenant_id=$1 AND r.property_id=$2`;
      const params = [tenantId, propertyId];
      if (roomTypeId) { sql += ` AND r.room_type_id = $3`; params.push(roomTypeId); }
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async updateRoomStatus(tenantId, id, status) {
      const r = await pool.query(
        `UPDATE rooms SET status=$3::room_status, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, status]
      );
      return r.rows[0] || null;
    },
    async setRoomActive(tenantId, id, active) {
      const r = await pool.query(
        `UPDATE rooms SET active=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, active]
      );
      return r.rows[0] || null;
    },

    // ----- room_features + M2M -----
    async insertRoomFeature(rec) {
      const r = await pool.query(
        `INSERT INTO room_features (tenant_id, property_id, code, name, active)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.code, rec.name, rec.active !== false]
      );
      return r.rows[0];
    },
    async listRoomFeatures(tenantId, propertyId) {
      const r = await pool.query(`SELECT * FROM room_features WHERE tenant_id=$1 AND property_id=$2 ORDER BY code`, [tenantId, propertyId]);
      return r.rows;
    },
    async attachRoomFeature(tenantId, roomId, featureId) {
      await pool.query(
        `INSERT INTO room_room_features (room_id, feature_id, tenant_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [roomId, featureId, tenantId]
      );
    },
    async listFeaturesForRoom(tenantId, roomId) {
      const r = await pool.query(
        `SELECT f.* FROM room_features f
           JOIN room_room_features rf ON rf.feature_id = f.id
          WHERE rf.tenant_id=$1 AND rf.room_id=$2 ORDER BY f.code`,
        [tenantId, roomId]
      );
      return r.rows;
    },

    // ----- guests -----
    async insertGuest(rec) {
      const r = await pool.query(
        `INSERT INTO guests (tenant_id, property_id, guest_type, title, first_name, last_name, gender, dob,
              nationality, language, email, mobile, address, passport_number, national_id,
              organization_name, tax_id, vip_flag, blacklisted_flag, notes, created_by)
         VALUES ($1,$2,$3::guest_type,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [rec.tenant_id, rec.property_id || null, rec.guest_type, rec.title || null,
         rec.first_name, rec.last_name || null, rec.gender || null, rec.dob || null,
         rec.nationality || null, rec.language || null, rec.email || null, rec.mobile || null,
         rec.address || null, rec.passport_number || null, rec.national_id || null,
         rec.organization_name || null, rec.tax_id || null,
         !!rec.vip_flag, !!rec.blacklisted_flag, rec.notes || null, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findGuestById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM guests WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async listGuests(tenantId, opts = {}) {
      const params = [tenantId];
      let sql = `SELECT * FROM guests WHERE tenant_id=$1`;
      if (opts.guestType) { sql += ` AND guest_type = $${params.length + 1}::guest_type`; params.push(opts.guestType); }
      if (opts.q) {
        params.push('%' + String(opts.q) + '%');
        const i = params.length;
        sql += ` AND (first_name ILIKE $${i} OR last_name ILIKE $${i} OR email ILIKE $${i} OR mobile ILIKE $${i} OR organization_name ILIKE $${i})`;
      }
      sql += ` ORDER BY created_at DESC LIMIT 200`;
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async updateGuestFlags(tenantId, id, { vip_flag, blacklisted_flag }) {
      const r = await pool.query(
        `UPDATE guests SET vip_flag=COALESCE($3, vip_flag), blacklisted_flag=COALESCE($4, blacklisted_flag), updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, vip_flag === undefined ? null : vip_flag, blacklisted_flag === undefined ? null : blacklisted_flag]
      );
      return r.rows[0] || null;
    },

    // ----- child policies -----
    async insertChildPolicy(rec) {
      const r = await pool.query(
        `INSERT INTO child_policies (tenant_id, property_id, code, name, description, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.code, rec.name, rec.description || null, rec.active !== false, rec.created_by]
      );
      return r.rows[0];
    },
    async insertChildAgeCategory(rec) {
      const r = await pool.query(
        `INSERT INTO child_age_categories (tenant_id, child_policy_id, code, name,
            age_from, age_to, stay_charge_pct, meal_charge_pct, counts_in_occupancy, requires_extra_bed, extra_bed_charge)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [rec.tenant_id, rec.child_policy_id, rec.code, rec.name,
         rec.age_from, rec.age_to, rec.stay_charge_pct || 0, rec.meal_charge_pct || 0,
         !!rec.counts_in_occupancy, !!rec.requires_extra_bed, rec.extra_bed_charge || 0]
      );
      return r.rows[0];
    },
    async loadChildPolicyWithCategories(tenantId, policyId) {
      const p = await pool.query(`SELECT * FROM child_policies WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, policyId]);
      if (!p.rows[0]) return null;
      const c = await pool.query(`SELECT * FROM child_age_categories WHERE tenant_id=$1 AND child_policy_id=$2 ORDER BY age_from`, [tenantId, policyId]);
      return Object.assign({}, p.rows[0], { categories: c.rows });
    },
    async listChildPolicies(tenantId, propertyId) {
      const r = await pool.query(`SELECT * FROM child_policies WHERE tenant_id=$1 AND property_id=$2 ORDER BY code`, [tenantId, propertyId]);
      return r.rows;
    },

    // ----- reservation counter -----
    async bumpReservationCounter({ tenantId, propertyId, year }) {
      // Single-statement upsert with RETURNING; PG handles concurrency via the
      // unique PK on (property_id, year). On insert, next_number starts at 2
      // (we are CLAIMING 1). On update, next_number is incremented and the
      // OLD value (= the value being claimed) is returned.
      const sql = `
        INSERT INTO reservation_counters (tenant_id, property_id, year, next_number, updated_at)
        VALUES ($1, $2, $3, 2, now())
        ON CONFLICT (property_id, year)
        DO UPDATE SET next_number = reservation_counters.next_number + 1, updated_at = now()
        RETURNING next_number - 1 AS claimed`;
      const r = await pool.query(sql, [tenantId, propertyId, year]);
      return parseInt(r.rows[0].claimed, 10);
    },

    // ----- reservations -----
    async insertReservation(rec) {
      const r = await pool.query(
        `INSERT INTO reservations (tenant_id, property_id, reservation_number, reservation_type,
              status, holder_guest_id, primary_adult_guest_id, arrival_date, departure_date,
              adults, children, room_type_id, rate_plan_id, rooms_count, notes,
              business_date, created_by, idempotency_key)
         VALUES ($1,$2,$3,$4::reservation_type,$5::reservation_status,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.reservation_number, rec.reservation_type,
         rec.status || 'INQUIRY', rec.holder_guest_id, rec.primary_adult_guest_id,
         rec.arrival_date, rec.departure_date, rec.adults, rec.children,
         rec.room_type_id, rec.rate_plan_id || null, rec.rooms_count || 1, rec.notes || null,
         rec.business_date || null, rec.created_by || null, rec.idempotency_key || null]
      );
      return r.rows[0];
    },
    async findReservationByIdempotencyKey(tenantId, idempotencyKey) {
      if (!idempotencyKey) return null;
      const r = await pool.query(
        `SELECT * FROM reservations WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1`,
        [tenantId, idempotencyKey]
      );
      return r.rows[0] || null;
    },
    async findReservationById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM reservations WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async findReservationByNumber(tenantId, propertyId, number) {
      const r = await pool.query(`SELECT * FROM reservations WHERE tenant_id=$1 AND property_id=$2 AND reservation_number=$3 LIMIT 1`, [tenantId, propertyId, number]);
      return r.rows[0] || null;
    },
    async setReservationStatus(tenantId, id, newStatus, { cancellationReason } = {}) {
      const r = await pool.query(
        `UPDATE reservations
            SET status=$3::reservation_status,
                cancelled_at=CASE WHEN $3 IN ('CANCELLED','NO_SHOW') THEN now() ELSE cancelled_at END,
                cancellation_reason=COALESCE($4, cancellation_reason),
                updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, newStatus, cancellationReason || null]
      );
      return r.rows[0] || null;
    },
    async setReservationConfirmation(tenantId, id, { confirmationNumber }) {
      const r = await pool.query(
        `UPDATE reservations
            SET confirmation_number=$3,
                updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, confirmationNumber || null]
      );
      return r.rows[0] || null;
    },
    async setReservationConfirmationSent(tenantId, id, sentAt) {
      const r = await pool.query(
        `UPDATE reservations
            SET confirmation_sent_at=COALESCE(confirmation_sent_at, $3),
                updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, sentAt || new Date()]
      );
      return r.rows[0] || null;
    },
    async listReservations(tenantId, propertyId, opts = {}) {
      const params = [tenantId, propertyId];
      let sql = `SELECT * FROM reservations WHERE tenant_id=$1 AND property_id=$2`;
      if (opts.status) { params.push(opts.status); sql += ` AND status=$${params.length}::reservation_status`; }
      if (opts.dateFrom)       { params.push(opts.dateFrom);       sql += ` AND arrival_date >= $${params.length}`; }
      if (opts.dateTo)         { params.push(opts.dateTo);         sql += ` AND arrival_date <= $${params.length}`; }
      if (opts.source_channel) { params.push(opts.source_channel); sql += ` AND source_channel = $${params.length}`; }
      sql += ` ORDER BY arrival_date DESC LIMIT 500`;
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async listReservationsOverlapping({ tenantId, propertyId, date, statuses, roomTypeId }) {
      const params = [tenantId, propertyId, date, statuses];
      let sql = `SELECT r.*, rt.code AS room_type_code FROM reservations r
                   JOIN room_types rt ON rt.id = r.room_type_id
                  WHERE r.tenant_id=$1 AND r.property_id=$2
                    AND r.arrival_date <= $3 AND r.departure_date > $3
                    AND r.status::text = ANY($4)`;
      if (roomTypeId) { params.push(roomTypeId); sql += ` AND r.room_type_id = $${params.length}`; }
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async listReservationsInRange({ tenantId, propertyId, dateFrom, dateTo, statuses, roomTypeId }) {
      const params = [tenantId, propertyId, dateFrom, dateTo, statuses];
      let sql = `SELECT r.*, rt.code AS room_type_code FROM reservations r
                   JOIN room_types rt ON rt.id = r.room_type_id
                  WHERE r.tenant_id=$1 AND r.property_id=$2
                    AND r.departure_date > $3 AND r.arrival_date < $4
                    AND r.status::text = ANY($5)`;
      if (roomTypeId) { params.push(roomTypeId); sql += ` AND r.room_type_id = $${params.length}`; }
      const r = await pool.query(sql, params);
      return r.rows;
    },
    // Phase 21: modify mutable booking fields (pre-stay). Whitelisted columns only;
    // the check-in/out lifecycle remains owned by the dedicated transition commands.
    async updateReservation(tenantId, id, fields = {}) {
      const ALLOWED = ['reservation_type', 'arrival_date', 'departure_date', 'adults',
                       'children', 'room_type_id', 'rate_plan_id', 'rooms_count', 'notes'];
      const sets = [];
      const params = [tenantId, id];
      for (const col of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(fields, col) && fields[col] !== undefined) {
          params.push(fields[col]);
          sets.push(`${col}=$${params.length}${col === 'reservation_type' ? '::reservation_type' : ''}`);
        }
      }
      if (sets.length === 0) return this.findReservationById(tenantId, id);
      const r = await pool.query(
        `UPDATE reservations SET ${sets.join(', ')}, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`, params);
      return r.rows[0] || null;
    },
    // Phase 21: move an in-house guest to a different room. Reassigns the
    // reservation and flips both rooms (old -> VACANT_DIRTY, new -> OCCUPIED).
    async reassignReservationRoom(tenantId, id, newRoomId) {
      const r = await pool.query(
        `UPDATE reservations SET assigned_room_id=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, newRoomId]);
      const row = r.rows[0];
      if (!row) return null;
      await pool.query(`UPDATE rooms SET status='OCCUPIED'::room_status, updated_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, newRoomId]);
      return row;
    },

    // ----- rate plans -----
    async insertRatePlan(rec) {
      const r = await pool.query(
        `INSERT INTO rate_plans (tenant_id, property_id, code, name, description, currency, base_rate, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.code, rec.name, rec.description || null,
         rec.currency || 'LKR', rec.base_rate || 0, rec.active !== false, rec.created_by]
      );
      return r.rows[0];
    },
    async findRatePlanById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM rate_plans WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async listRatePlans(tenantId, propertyId) {
      const r = await pool.query(`SELECT * FROM rate_plans WHERE tenant_id=$1 AND property_id=$2 ORDER BY code`, [tenantId, propertyId]);
      return r.rows;
    },
    async insertRatePlanPeriod(rec) {
      const r = await pool.query(
        `INSERT INTO rate_plan_periods (tenant_id, rate_plan_id, name, date_from, date_to, rate)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [rec.tenant_id, rec.rate_plan_id, rec.name || null, rec.date_from, rec.date_to, rec.rate]
      );
      return r.rows[0];
    },
    async insertRatePlanPricing(rec) {
      const r = await pool.query(
        `INSERT INTO rate_plan_pricing (tenant_id, rate_plan_id, pricing_type, occupancy_count, child_category_code, rate, rate_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [rec.tenant_id, rec.rate_plan_id, rec.pricing_type, rec.occupancy_count || null,
         rec.child_category_code || null, rec.rate || 0, rec.rate_pct || null]
      );
      return r.rows[0];
    },
    async listRatePlanPeriods(tenantId, ratePlanId) {
      const r = await pool.query(`SELECT * FROM rate_plan_periods WHERE tenant_id=$1 AND rate_plan_id=$2 ORDER BY date_from`, [tenantId, ratePlanId]);
      return r.rows;
    },
    async listRatePlanPricing(tenantId, ratePlanId) {
      const r = await pool.query(`SELECT * FROM rate_plan_pricing WHERE tenant_id=$1 AND rate_plan_id=$2`, [tenantId, ratePlanId]);
      return r.rows;
    },

    // ----- property lookup (needed by reservation number gen) -----
    async findPropertyById(tenantId, propertyId) {
      const r = await pool.query(`SELECT * FROM properties WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, propertyId]);
      return r.rows[0] || null;
    },

    // ----- meal plans (Phase 6 / C4) -----
    async insertMealPlan(rec) {
      const r = await pool.query(
        `INSERT INTO meal_plans (tenant_id, property_id, code, name, basis,
              includes_breakfast, includes_lunch, includes_dinner, includes_snack,
              adult_rate, child_rate, currency, active, description, created_by)
         VALUES ($1,$2,$3,$4,$5::meal_plan_basis,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.code, rec.name, rec.basis,
         !!rec.includes_breakfast, !!rec.includes_lunch, !!rec.includes_dinner, !!rec.includes_snack,
         rec.adult_rate || 0, rec.child_rate || 0, rec.currency || 'LKR',
         rec.active !== false, rec.description || null, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findMealPlanById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM meal_plans WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async listMealPlans(tenantId, propertyId) {
      const r = await pool.query(`SELECT * FROM meal_plans WHERE tenant_id=$1 AND property_id=$2 ORDER BY code`, [tenantId, propertyId]);
      return r.rows;
    },
    // ----- stale business-date sweep (Phase 6 / C13) -----
    async listPropertiesWithStaleBusinessDate(thresholdHours) {
      // age_hours computed as hours since current_business_date end-of-day
      const r = await pool.query(
        `SELECT p.id, p.tenant_id, p.code, p.current_business_date,
                EXTRACT(EPOCH FROM (now() - (p.current_business_date::timestamptz + INTERVAL '1 day'))) / 3600 AS age_hours
           FROM properties p
          WHERE p.current_business_date IS NOT NULL
            AND p.active = true
            AND (now() - (p.current_business_date::timestamptz + INTERVAL '1 day')) > make_interval(hours => $1)`,
        [thresholdHours]
      );
      return r.rows;
    },

    async attachMealPlanToRatePlan(tenantId, ratePlanId, mealPlanId) {
      const r = await pool.query(
        `UPDATE rate_plans SET meal_plan_id=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, ratePlanId, mealPlanId]
      );
      return r.rows[0] || null;
    },

    // ----- check-in / check-out (Phase 5.5) -----
    async checkInReservation(tenantId, id, { userId, businessDate, assignedRoomId }) {
      const r = await pool.query(
        `UPDATE reservations
            SET status='CHECKED_IN'::reservation_status,
                checked_in_at=now(),
                checked_in_by=$3,
                assigned_room_id=COALESCE($4, assigned_room_id),
                updated_at=now()
          WHERE tenant_id=$1 AND id=$2
          RETURNING *`,
        [tenantId, id, userId || null, assignedRoomId || null]
      );
      // Also flip the assigned room to OCCUPIED if provided.
      if (assignedRoomId) {
        await pool.query(
          `UPDATE rooms SET status='OCCUPIED'::room_status, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [tenantId, assignedRoomId]
        );
      }
      return r.rows[0] || null;
    },
    async checkOutReservation(tenantId, id, { userId }) {
      const r = await pool.query(
        `UPDATE reservations
            SET status='CHECKED_OUT'::reservation_status,
                checked_out_at=now(),
                checked_out_by=$3,
                updated_at=now()
          WHERE tenant_id=$1 AND id=$2
          RETURNING *`,
        [tenantId, id, userId || null]
      );
      // Mark assigned room VACANT_DIRTY for housekeeping.
      const row = r.rows[0];
      if (row && row.assigned_room_id) {
        await pool.query(
          `UPDATE rooms SET status='VACANT_DIRTY'::room_status, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [tenantId, row.assigned_room_id]
        );
      }
      return row || null;
    }
  };

  // ---- finance: cost centers (Phase 8 / C11) --------------------------
  const costCenterRepo = {
    async insertCostCenter(rec) {
      const r = await pool.query(
        `INSERT INTO cost_centers (tenant_id, property_id, code, name, type, description, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5::cost_center_type,$6,$7,$8) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.code, rec.name, rec.type,
         rec.description || null, rec.is_active !== false, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findCostCenterById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM cost_centers WHERE tenant_id=$1 AND id=$2 LIMIT 1`,
        [tenantId, id]);
      return r.rows[0] || null;
    },
    async listCostCenters(tenantId, propertyId, opts = {}) {
      const params = [tenantId, propertyId];
      let sql = `SELECT * FROM cost_centers WHERE tenant_id=$1 AND property_id=$2`;
      if (opts.activeOnly) sql += ` AND is_active = true`;
      sql += ` ORDER BY code`;
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async updateCostCenter(tenantId, id, patch) {
      const r = await pool.query(
        `UPDATE cost_centers SET
            name        = COALESCE($3, name),
            type        = COALESCE($4::cost_center_type, type),
            description = COALESCE($5, description),
            updated_at  = now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, patch.name || null, patch.type || null, patch.description || null]
      );
      return r.rows[0] || null;
    },
    async setCostCenterActive(tenantId, id, active) {
      const r = await pool.query(
        `UPDATE cost_centers SET is_active=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, active]);
      return r.rows[0] || null;
    }
  };

  // ---- finance: revenue posting map (Phase 8 / C12) -------------------
  const revenueMapRepo = {
    async upsertRevenueMap(rec) {
      const r = await pool.query(
        `INSERT INTO revenue_posting_map (tenant_id, property_id, event_type, revenue_type,
              cost_center_id, debit_account, credit_account, is_active, description, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, property_id, event_type)
         DO UPDATE SET
            revenue_type = EXCLUDED.revenue_type,
            cost_center_id = EXCLUDED.cost_center_id,
            debit_account  = EXCLUDED.debit_account,
            credit_account = EXCLUDED.credit_account,
            is_active      = EXCLUDED.is_active,
            description    = EXCLUDED.description,
            updated_at     = now()
         RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.event_type, rec.revenue_type,
         rec.cost_center_id || null, rec.debit_account, rec.credit_account,
         rec.is_active !== false, rec.description || null, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findRevenueMap(tenantId, propertyId, eventType) {
      const r = await pool.query(
        `SELECT * FROM revenue_posting_map
          WHERE tenant_id=$1 AND property_id=$2 AND event_type=$3 AND is_active=true
          LIMIT 1`,
        [tenantId, propertyId, eventType]);
      return r.rows[0] || null;
    },
    async listRevenueMaps(tenantId, propertyId) {
      const r = await pool.query(
        `SELECT * FROM revenue_posting_map WHERE tenant_id=$1 AND property_id=$2 ORDER BY event_type`,
        [tenantId, propertyId]);
      return r.rows;
    },
    async deleteRevenueMap(tenantId, propertyId, eventType) {
      const r = await pool.query(
        `DELETE FROM revenue_posting_map WHERE tenant_id=$1 AND property_id=$2 AND event_type=$3`,
        [tenantId, propertyId, eventType]);
      return r.rowCount;
    }
  };

  // ---- finance: ledger (Phase 8 - double-entry backbone) --------------
  // A batch is the balance unit; entries are one-sided legs. See
  // migration 0044 and src/services/finance/ledger.js.
  const ledgerRepo = {
    async insertLedgerBatch(rec) {
      const r = await pool.query(
        `INSERT INTO ledger_batches (tenant_id, property_id, entry_type, reference_type, reference_id,
              currency, total_debit, total_credit, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.entry_type, rec.reference_type, rec.reference_id,
         rec.currency || 'LKR', rec.total_debit || 0, rec.total_credit || 0, rec.created_by || null]
      );
      return r.rows[0];
    },
    async insertLedgerEntry(rec) {
      const r = await pool.query(
        `INSERT INTO ledger_entries (tenant_id, property_id, batch_id, entry_type, reference_type,
              reference_id, cost_center_id, account_code, debit_amount, credit_amount, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.batch_id, rec.entry_type, rec.reference_type,
         rec.reference_id, rec.cost_center_id || null, rec.account_code,
         rec.debit_amount || 0, rec.credit_amount || 0, rec.currency || 'LKR']
      );
      return r.rows[0];
    },
    async findLedgerByReference(tenantId, refType, refId) {
      const r = await pool.query(
        `SELECT * FROM ledger_entries
          WHERE tenant_id=$1 AND reference_type=$2 AND reference_id=$3
          ORDER BY created_at, id`,
        [tenantId, refType, refId]);
      return r.rows;
    },
    async listLedgerByBatch(batchId) {
      const r = await pool.query(
        `SELECT * FROM ledger_entries WHERE batch_id=$1 ORDER BY created_at, id`, [batchId]);
      return r.rows;
    },
    async findBatchById(tenantId, batchId) {
      const r = await pool.query(`SELECT * FROM ledger_batches WHERE tenant_id=$1 AND id=$2 LIMIT 1`,
        [tenantId, batchId]);
      return r.rows[0] || null;
    },
    // Reverse a posted batch by emitting an offsetting (debit<->credit swapped)
    // REVERSAL batch. Idempotent: a batch already reverted returns null.
    async revertBatch(tenantId, batchId) {
      const b = await this.findBatchById(tenantId, batchId);
      if (!b || b.reverted_at) return null;
      const original = await this.listLedgerByBatch(batchId);
      const revBatch = await this.insertLedgerBatch({
        tenant_id: tenantId, property_id: b.property_id, entry_type: 'REVERSAL',
        reference_type: 'ledger_batch', reference_id: batchId, currency: b.currency,
        total_debit: b.total_credit, total_credit: b.total_debit, created_by: b.created_by
      });
      for (const e of original) {
        await this.insertLedgerEntry({
          tenant_id: tenantId, property_id: e.property_id, batch_id: revBatch.id,
          entry_type: 'REVERSAL', reference_type: 'ledger_batch', reference_id: batchId,
          cost_center_id: e.cost_center_id, account_code: e.account_code,
          debit_amount: e.credit_amount, credit_amount: e.debit_amount, currency: e.currency
        });
      }
      await pool.query(
        `UPDATE ledger_batches SET reverted_at=now(), reverted_by_batch_id=$3
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, batchId, revBatch.id]);
      return revBatch;
    },
    async reportByCostCenter(tenantId, propertyId, { dateFrom, dateTo } = {}) {
      const params = [tenantId, propertyId];
      let sql = `SELECT cost_center_id, SUM(debit_amount) AS debit, SUM(credit_amount) AS credit
                   FROM ledger_entries WHERE tenant_id=$1 AND property_id=$2`;
      if (dateFrom) { params.push(dateFrom); sql += ` AND created_at >= $${params.length}`; }
      if (dateTo)   { params.push(dateTo);   sql += ` AND created_at <= $${params.length}`; }
      sql += ` GROUP BY cost_center_id`;
      const r = await pool.query(sql, params);
      return r.rows.map((row) => ({ cost_center_id: row.cost_center_id,
        debit: Number(row.debit), credit: Number(row.credit) }));
    },
    async revenueSummary(tenantId, propertyId, { dateFrom, dateTo } = {}) {
      const params = [tenantId, propertyId];
      let sql = `SELECT COALESCE(SUM(credit_amount),0) AS total
                   FROM ledger_entries
                  WHERE tenant_id=$1 AND property_id=$2 AND entry_type='INVOICE'`;
      if (dateFrom) { params.push(dateFrom); sql += ` AND created_at >= $${params.length}`; }
      if (dateTo)   { params.push(dateTo);   sql += ` AND created_at <= $${params.length}`; }
      const r = await pool.query(sql, params);
      return { total_revenue: Number(r.rows[0].total) };
    }
  };

  // ---- folio repo (Phase 5.5 readiness) -------------------------------
  const folioRepo = {
    async bumpFolioCounter({ tenantId, propertyId, year }) {
      const sql = `
        INSERT INTO folio_counters (tenant_id, property_id, year, next_number, updated_at)
        VALUES ($1, $2, $3, 2, now())
        ON CONFLICT (property_id, year)
        DO UPDATE SET next_number = folio_counters.next_number + 1, updated_at = now()
        RETURNING next_number - 1 AS claimed`;
      const r = await pool.query(sql, [tenantId, propertyId, year]);
      return parseInt(r.rows[0].claimed, 10);
    },
    async insertFolio(rec) {
      const r = await pool.query(
        `INSERT INTO folios (tenant_id, property_id, reservation_id, folio_number, status, currency,
              guest_id, business_date, created_by)
         VALUES ($1,$2,$3,$4,$5::folio_status,$6,$7,$8,$9) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.reservation_id || null, rec.folio_number,
         rec.status || 'OPEN', rec.currency || 'LKR',
         rec.guest_id || null, rec.business_date || null, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findFolioById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM folios WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async listFoliosForReservation(tenantId, reservationId) {
      const r = await pool.query(`SELECT * FROM folios WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY opened_at`,
        [tenantId, reservationId]);
      return r.rows;
    },
    // Phase 21: property-scoped folio listing (read).
    async listFolios(tenantId, propertyId, opts = {}) {
      const params = [tenantId, propertyId];
      let sql = `SELECT * FROM folios WHERE tenant_id=$1 AND property_id=$2`;
      if (opts.status) { params.push(opts.status); sql += ` AND status=$${params.length}::folio_status`; }
      if (opts.reservation_id) { params.push(opts.reservation_id); sql += ` AND reservation_id=$${params.length}`; }
      sql += ` ORDER BY opened_at DESC LIMIT 500`;
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async insertFolioLine(rec) {
      const r = await pool.query(
        `INSERT INTO folio_lines (tenant_id, folio_id, charge_type, description, quantity,
              unit_amount, amount, tax_amount, business_date, posted_by, source_module, source_ref, metadata)
         VALUES ($1,$2,$3::folio_charge_type,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [rec.tenant_id, rec.folio_id, rec.charge_type, rec.description || null,
         rec.quantity || 1, rec.unit_amount || 0, rec.amount || 0, rec.tax_amount || 0,
         rec.business_date, rec.posted_by || null, rec.source_module || 'PMS',
         rec.source_ref || null, rec.metadata || {}]
      );
      // Roll up folio totals in same transaction-equivalent (PG cheap to recompute).
      await pool.query(
        `UPDATE folios f SET
           total_charges  = (SELECT COALESCE(SUM(amount),0)
                               FROM folio_lines WHERE folio_id=f.id AND charge_type NOT IN ('PAYMENT','REFUND')),
           total_payments = (SELECT COALESCE(SUM(amount),0)
                               FROM folio_lines WHERE folio_id=f.id AND charge_type IN ('PAYMENT','REFUND')),
           balance        = (SELECT COALESCE(SUM(amount),0)
                               FROM folio_lines WHERE folio_id=f.id),
           updated_at     = now()
         WHERE id=$1`,
        [rec.folio_id]
      );
      return r.rows[0];
    },
    async listFolioLines(tenantId, folioId) {
      const r = await pool.query(
        `SELECT * FROM folio_lines WHERE tenant_id=$1 AND folio_id=$2 ORDER BY posted_at`,
        [tenantId, folioId]
      );
      return r.rows;
    },
    // ----- reservation groups (Phase 7 / C5) -----
    async insertReservationGroup(rec) {
      const r = await pool.query(
        `INSERT INTO reservation_groups (tenant_id, property_id, group_type, code, name,
              holder_guest_id, arrival_date, departure_date, total_rooms, total_guests,
              cutoff_date, notes, created_by)
         VALUES ($1,$2,$3::reservation_group_type,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.group_type, rec.code, rec.name,
         rec.holder_guest_id || null, rec.arrival_date || null, rec.departure_date || null,
         rec.total_rooms || 0, rec.total_guests || 0,
         rec.cutoff_date || null, rec.notes || null, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findReservationGroupById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM reservation_groups WHERE tenant_id=$1 AND id=$2 LIMIT 1`,
        [tenantId, id]);
      return r.rows[0] || null;
    },
    async listReservationsInGroup(tenantId, groupId) {
      const r = await pool.query(
        `SELECT r.*, rt.code AS room_type_code
           FROM reservations r
           JOIN room_types rt ON rt.id = r.room_type_id
          WHERE r.tenant_id=$1 AND r.group_id=$2
          ORDER BY r.arrival_date, r.reservation_number`,
        [tenantId, groupId]);
      return r.rows;
    },
    async attachReservationToGroup(tenantId, reservationId, groupId) {
      const r = await pool.query(
        `UPDATE reservations SET group_id=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, reservationId, groupId]);
      return r.rows[0] || null;
    },
    async bumpGroupTotals(tenantId, groupId, { roomsDelta = 0, guestsDelta = 0 }) {
      const r = await pool.query(
        `UPDATE reservation_groups
            SET total_rooms = total_rooms + $3,
                total_guests = total_guests + $4,
                updated_at = now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, groupId, roomsDelta, guestsDelta]);
      return r.rows[0] || null;
    },

    // ----- vouchers (Phase 7 / C6) -----
    async insertVoucher(rec) {
      const r = await pool.query(
        `INSERT INTO vouchers (tenant_id, property_id, voucher_number, agent_guest_id, contract_id,
              guest_name, arrival_date, departure_date, room_type_id, status, amount, currency,
              expires_at, payload, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::voucher_status,$11,$12,$13,$14,$15) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.voucher_number, rec.agent_guest_id || null,
         rec.contract_id || null, rec.guest_name || null,
         rec.arrival_date, rec.departure_date, rec.room_type_id || null,
         rec.status || 'ISSUED', rec.amount || 0, rec.currency || 'LKR',
         rec.expires_at || null, rec.payload || {}, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findVoucherById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM vouchers WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async findVoucherByNumber(tenantId, propertyId, number) {
      const r = await pool.query(`SELECT * FROM vouchers WHERE tenant_id=$1 AND property_id=$2 AND voucher_number=$3 LIMIT 1`,
        [tenantId, propertyId, number]);
      return r.rows[0] || null;
    },
    async redeemVoucher(tenantId, id, reservationId) {
      const r = await pool.query(
        `UPDATE vouchers SET status='REDEEMED'::voucher_status,
                redeemed_at=now(), redeemed_reservation_id=$3
          WHERE tenant_id=$1 AND id=$2 AND status='ISSUED'::voucher_status
          RETURNING *`,
        [tenantId, id, reservationId]
      );
      return r.rows[0] || null;
    },
    async cancelVoucher(tenantId, id, reason) {
      const r = await pool.query(
        `UPDATE vouchers SET status='CANCELLED'::voucher_status,
                cancelled_at=now(), cancellation_reason=$3
          WHERE tenant_id=$1 AND id=$2 AND status='ISSUED'::voucher_status
          RETURNING *`,
        [tenantId, id, reason || null]
      );
      return r.rows[0] || null;
    },

    // ----- allocations lifecycle (Phase 7 / C7) -----
    async insertAllocation(rec) {
      const r = await pool.query(
        `INSERT INTO allocations (tenant_id, property_id, contract_id, partner_guest_id,
              room_type_id, date_from, date_to, qty_blocked, qty_consumed,
              release_days, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::allocation_status,$12,$13) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.contract_id || null, rec.partner_guest_id || null,
         rec.room_type_id, rec.date_from, rec.date_to,
         rec.qty_blocked, rec.qty_consumed || 0,
         rec.release_days || 0, rec.status || 'ACTIVE', rec.notes || null, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findAllocationById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM allocations WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async consumeAllocation(tenantId, id, qty) {
      // Atomic check-and-bump; refuses to consume past qty_blocked.
      const r = await pool.query(
        `UPDATE allocations
            SET qty_consumed = qty_consumed + $3,
                status = CASE WHEN (qty_consumed + $3) >= qty_blocked
                              THEN 'EXHAUSTED'::allocation_status
                              ELSE status END,
                updated_at = now()
          WHERE tenant_id=$1 AND id=$2
            AND status='ACTIVE'::allocation_status
            AND (qty_consumed + $3) <= qty_blocked
          RETURNING *`,
        [tenantId, id, qty]
      );
      return r.rows[0] || null;
    },
    async decrementAllocationConsumption(tenantId, id, qty) {
      const r = await pool.query(
        `UPDATE allocations
            SET qty_consumed = GREATEST(0, qty_consumed - $3),
                status = CASE WHEN status='EXHAUSTED'::allocation_status
                              THEN 'ACTIVE'::allocation_status
                              ELSE status END,
                updated_at = now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, qty]
      );
      return r.rows[0] || null;
    },
    async releaseAllocation(tenantId, id) {
      const r = await pool.query(
        `UPDATE allocations
            SET status='RELEASED'::allocation_status, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'::allocation_status
          RETURNING *`,
        [tenantId, id]
      );
      return r.rows[0] || null;
    },
    async listAllocationsDueForRelease(asOfDate) {
      // ACTIVE allocations whose (date_from - release_days days) <= asOfDate.
      const r = await pool.query(
        `SELECT * FROM allocations
          WHERE status='ACTIVE'::allocation_status
            AND (date_from - (release_days || ' days')::interval)::date <= $1::date`,
        [asOfDate]
      );
      return r.rows;
    },

    // ----- invoices (Phase 7 / C9) -----
    async bumpInvoiceCounter({ tenantId, propertyId, year }) {
      const sql = `
        INSERT INTO invoice_counters (tenant_id, property_id, year, next_number, updated_at)
        VALUES ($1, $2, $3, 2, now())
        ON CONFLICT (property_id, year)
        DO UPDATE SET next_number = invoice_counters.next_number + 1, updated_at = now()
        RETURNING next_number - 1 AS claimed`;
      const r = await pool.query(sql, [tenantId, propertyId, year]);
      return parseInt(r.rows[0].claimed, 10);
    },
    async insertInvoice(rec) {
      const r = await pool.query(
        `INSERT INTO invoices (tenant_id, property_id, folio_id, invoice_number, status,
              currency, total_amount, tax_amount, balance, bill_to_guest_id, business_date,
              payload, cost_center_id, created_by)
         VALUES ($1,$2,$3,$4,$5::invoice_status,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.folio_id, rec.invoice_number, rec.status || 'ISSUED',
         rec.currency || 'LKR', rec.total_amount || 0, rec.tax_amount || 0,
         rec.balance || 0, rec.bill_to_guest_id || null,
         rec.business_date || null, rec.payload || {}, rec.cost_center_id || null, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findInvoiceById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM invoices WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async findInvoiceByNumber(tenantId, propertyId, number) {
      const r = await pool.query(`SELECT * FROM invoices WHERE tenant_id=$1 AND property_id=$2 AND invoice_number=$3 LIMIT 1`,
        [tenantId, propertyId, number]);
      return r.rows[0] || null;
    },
    async listInvoices(tenantId, propertyId, opts = {}) {
      const params = [tenantId, propertyId];
      let sql = `SELECT * FROM invoices WHERE tenant_id=$1 AND property_id=$2`;
      if (opts.status) { params.push(opts.status); sql += ` AND status=$${params.length}::invoice_status`; }
      sql += ` ORDER BY issued_at DESC LIMIT 500`;
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async voidInvoice(tenantId, id, reason) {
      const r = await pool.query(
        `UPDATE invoices SET status='VOIDED'::invoice_status, voided_at=now(),
                void_reason=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status='ISSUED'::invoice_status
          RETURNING *`,
        [tenantId, id, reason || null]
      );
      return r.rows[0] || null;
    },

    // ----- payment allocations (Phase 7 / C8) -----
    async insertPaymentAllocation(rec) {
      const r = await pool.query(
        `INSERT INTO payment_allocations
           (tenant_id, folio_id, payment_line_id, charge_line_id,
            amount_allocated, allocated_by, business_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [rec.tenant_id, rec.folio_id, rec.payment_line_id, rec.charge_line_id,
         rec.amount_allocated, rec.allocated_by || null, rec.business_date || null]
      );
      return r.rows[0];
    },
    async listAllocationsForPayment(tenantId, paymentLineId) {
      const r = await pool.query(
        `SELECT * FROM payment_allocations WHERE tenant_id=$1 AND payment_line_id=$2 ORDER BY allocated_at`,
        [tenantId, paymentLineId]);
      return r.rows;
    },
    async listAllocationsForCharge(tenantId, chargeLineId) {
      const r = await pool.query(
        `SELECT * FROM payment_allocations WHERE tenant_id=$1 AND charge_line_id=$2 ORDER BY allocated_at`,
        [tenantId, chargeLineId]);
      return r.rows;
    },
    async listAllocationsForFolio(tenantId, folioId) {
      const r = await pool.query(
        `SELECT * FROM payment_allocations WHERE tenant_id=$1 AND folio_id=$2 ORDER BY allocated_at`,
        [tenantId, folioId]);
      return r.rows;
    },
    async findFolioLineById(tenantId, id) {
      const r = await pool.query(
        `SELECT fl.* FROM folio_lines fl
           JOIN folios f ON f.id = fl.folio_id
          WHERE f.tenant_id=$1 AND fl.id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },

    async closeFolio(tenantId, id) {
      const r = await pool.query(
        `UPDATE folios SET status='CLOSED'::folio_status, closed_at=now(), updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id]
      );
      return r.rows[0] || null;
    }
  };

  // ---- housekeeping repo (Phase 5.5 readiness) ------------------------
  const housekeepingRepo = {
    async insertTask(rec) {
      const r = await pool.query(
        `INSERT INTO housekeeping_tasks (tenant_id, property_id, room_id, reservation_id,
              task_type, status, priority, scheduled_for, notes, created_by)
         VALUES ($1,$2,$3,$4,$5::hk_task_type,$6::hk_task_status,$7,$8,$9,$10) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.room_id || null, rec.reservation_id || null,
         rec.task_type, rec.status || 'PENDING', rec.priority || 3,
         rec.scheduled_for || null, rec.notes || null, rec.created_by || null]
      );
      return r.rows[0];
    },
    async findTaskById(tenantId, id) {
      const r = await pool.query(`SELECT * FROM housekeeping_tasks WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, id]);
      return r.rows[0] || null;
    },
    async assignTask(tenantId, id, assigneeUserId) {
      const r = await pool.query(
        `UPDATE housekeeping_tasks SET status='ASSIGNED'::hk_task_status, assigned_to=$3, assigned_at=now(), updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, assigneeUserId]
      );
      return r.rows[0] || null;
    },
    async completeTask(tenantId, id, { verifiedBy, notes } = {}) {
      const r = await pool.query(
        `UPDATE housekeeping_tasks
            SET status='COMPLETED'::hk_task_status, completed_at=now(),
                verified_by=$3, verified_at=CASE WHEN $3 IS NULL THEN NULL ELSE now() END,
                notes=COALESCE($4, notes), updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, verifiedBy || null, notes || null]
      );
      return r.rows[0] || null;
    },
    async listTasks(tenantId, propertyId, opts = {}) {
      const params = [tenantId, propertyId];
      let sql = `SELECT * FROM housekeeping_tasks WHERE tenant_id=$1 AND property_id=$2`;
      if (opts.status) { params.push(opts.status); sql += ` AND status=$${params.length}::hk_task_status`; }
      if (opts.assigned_to) { params.push(opts.assigned_to); sql += ` AND assigned_to=$${params.length}`; }
      sql += ` ORDER BY priority, scheduled_for NULLS LAST, created_at LIMIT 500`;
      const r = await pool.query(sql, params);
      return r.rows;
    }
  };

  // ---- night audit repo (Phase 5.5) -----------------------------------
  const nightAuditRepo = {
    async insertRun(rec) {
      const r = await pool.query(
        `INSERT INTO night_audit_runs (tenant_id, property_id, business_date, next_business_date,
              status, triggered_by, trigger_kind)
         VALUES ($1,$2,$3,$4,$5::night_audit_status,$6,$7) RETURNING *`,
        [rec.tenant_id, rec.property_id, rec.business_date, rec.next_business_date,
         rec.status || 'PENDING', rec.triggered_by || null, rec.trigger_kind || 'MANUAL']
      );
      return r.rows[0];
    },
    async completeRun(tenantId, id, payload) {
      const r = await pool.query(
        `UPDATE night_audit_runs SET status='COMPLETED'::night_audit_status,
                completed_at=now(),
                duration_ms=EXTRACT(EPOCH FROM (now()-started_at))::int*1000,
                reservations_arrived=$3, reservations_departed=$4, reservations_no_show=$5,
                rooms_charged=$6, total_room_revenue=$7, payload=$8
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, payload.reservations_arrived || 0, payload.reservations_departed || 0,
         payload.reservations_no_show || 0, payload.rooms_charged || 0,
         payload.total_room_revenue || 0, payload || {}]
      );
      return r.rows[0] || null;
    },
    async failRun(tenantId, id, err) {
      const r = await pool.query(
        `UPDATE night_audit_runs SET status='FAILED'::night_audit_status, completed_at=now(),
                error=$3, duration_ms=EXTRACT(EPOCH FROM (now()-started_at))::int*1000
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, id, String(err && err.message || err || '').slice(0, 2000)]
      );
      return r.rows[0] || null;
    },
    async findLatestRun(tenantId, propertyId) {
      const r = await pool.query(
        `SELECT * FROM night_audit_runs WHERE tenant_id=$1 AND property_id=$2
         ORDER BY started_at DESC LIMIT 1`,
        [tenantId, propertyId]
      );
      return r.rows[0] || null;
    },
    // Phase 21: night-audit run history (read).
    async listRuns(tenantId, propertyId, limit = 50) {
      const r = await pool.query(
        `SELECT * FROM night_audit_runs WHERE tenant_id=$1 AND property_id=$2
         ORDER BY started_at DESC LIMIT $3`,
        [tenantId, propertyId, Math.min(Number(limit) || 50, 200)]
      );
      return r.rows;
    },
    async setPropertyBusinessDateLocked(tenantId, propertyId, locked) {
      await pool.query(
        `UPDATE properties SET business_date_locked=$3, updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, propertyId, !!locked]
      );
    },
    async advancePropertyBusinessDate(tenantId, propertyId, newBusinessDate) {
      await pool.query(
        `UPDATE properties SET current_business_date=$3, business_date_locked=false, updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, propertyId, newBusinessDate]
      );
    }
  };

  // ---- invitation repo (Phase 57) ------------------------------------
  const invitationRepo = {
    async insertInvitation(rec, client) {
      if (!client || typeof client.query !== 'function') {
        const err = new Error('Invitation client required');
        err.code = 'INVITATION_CLIENT_REQUIRED';
        throw err;
      }
      const r = await client.query(
        `INSERT INTO user_invitations
           (tenant_id, email, token_hash, invited_by, role_codes, property_ids, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [rec.tenant_id, rec.email, rec.token_hash, rec.invited_by || null,
         rec.role_codes || [], rec.property_ids || [], rec.expires_at]
      );
      return r.rows[0];
    },
    async findInvitationByTokenHash(hash) {
      // Runs on unrestricted pool — token is opaque, no tenant context at acceptance time.
      const r = await pool.query(
        `SELECT * FROM user_invitations WHERE token_hash = $1 LIMIT 1`, [hash]
      );
      return r.rows[0] || null;
    },
    async findInvitationById(id) {
      const r = await pool.query(
        `SELECT * FROM user_invitations WHERE id = $1 LIMIT 1`, [id]
      );
      return r.rows[0] || null;
    },
    async markInvitationAccepted(id, acceptedBy) {
      const r = await pool.query(
        `UPDATE user_invitations
            SET status = 'accepted', accepted_at = now(), accepted_by = $2, updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING *`,
        [id, acceptedBy || null]
      );
      return r.rows[0] || null;
    },
    async markInvitationRevoked(id, revokedBy) {
      const r = await pool.query(
        `UPDATE user_invitations
            SET status = 'revoked', revoked_at = now(), revoked_by = $2, updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING *`,
        [id, revokedBy || null]
      );
      return r.rows[0] || null;
    },
    async listInvitations(tenantId, status) {
      const sql = status
        ? `SELECT * FROM user_invitations WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 200`
        : `SELECT * FROM user_invitations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`;
      const r = await pool.query(sql, status ? [tenantId, status] : [tenantId]);
      return r.rows;
    },
    async expireStaleInvitations() {
      const r = await pool.query(
        `UPDATE user_invitations SET status = 'expired', updated_at = now()
          WHERE status = 'pending' AND expires_at < now()`
      );
      return r.rowCount;
    }
  };

  // ---- password-reset repo (Phase 57) --------------------------------
  const passwordResetRepo = {
    async insertPasswordResetToken(rec, client) {
      if (!client || typeof client.query !== 'function') {
        const err = new Error('Password reset client required');
        err.code = 'PASSWORD_RESET_CLIENT_REQUIRED';
        throw err;
      }
      const r = await client.query(
        `INSERT INTO password_reset_tokens (user_id, tenant_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [rec.user_id, rec.tenant_id, rec.token_hash, rec.expires_at]
      );
      return r.rows[0];
    },
    // Runs on unrestricted pool — token is opaque, tenant not known at reset time.
    async findPasswordResetToken(hash) {
      const r = await pool.query(
        `SELECT * FROM password_reset_tokens WHERE token_hash = $1 LIMIT 1`, [hash]
      );
      return r.rows[0] || null;
    },
    async markPasswordResetTokenUsed(id) {
      await pool.query(
        `UPDATE password_reset_tokens SET status = 'used', used_at = now() WHERE id = $1`, [id]
      );
    },
    async revokeActivePasswordResetTokensForUser(userId, client) {
      if (!client || typeof client.query !== 'function') {
        const err = new Error('Password reset client required');
        err.code = 'PASSWORD_RESET_CLIENT_REQUIRED';
        throw err;
      }
      await client.query(
        `UPDATE password_reset_tokens SET status = 'revoked'
          WHERE user_id = $1 AND status = 'pending'`,
        [userId]
      );
    },
    async updateUserPassword(userId, passwordHash) {
      await pool.query(
        `UPDATE users
            SET password_hash = $2,
                status = CASE WHEN status = 'PENDING_PASSWORD_RESET' THEN 'ACTIVE'::user_status ELSE status END,
                failed_login_count = 0,
                locked_until = NULL,
                updated_at = now()
          WHERE id = $1`,
        [userId, passwordHash]
      );
    }
  };

  // ---- OTA inbound event deduplication repo (Phase 58) -----------------
  // All methods REQUIRE an explicit tenant-scoped transaction client so that
  // RLS (migration 0075) fires. Executing through the unrestricted shared pool
  // is forbidden; a bounded internal error is thrown when client is absent.
  const otaInboundEventDedupRepo = {
    _requireClient(client) {
      if (!client) throw Object.assign(
        new Error('otaDedup: tenant-scoped transaction client required'),
        { code: 'OTA_DEDUP_CLIENT_REQUIRED' }
      );
    },
    async upsert({ tenantId, propertyId, channelCode, eventType, dedupKey }, client) {
      this._requireClient(client);
      if (!tenantId)    throw Object.assign(new Error('otaDedup.upsert: tenantId required'),    { code: 'INVALID_INPUT' });
      if (!channelCode) throw Object.assign(new Error('otaDedup.upsert: channelCode required'), { code: 'INVALID_INPUT' });
      if (!eventType)   throw Object.assign(new Error('otaDedup.upsert: eventType required'),   { code: 'INVALID_INPUT' });
      if (!dedupKey)    throw Object.assign(new Error('otaDedup.upsert: dedupKey required'),    { code: 'INVALID_INPUT' });
      const r = await client.query(
        `INSERT INTO ota_inbound_event_dedup
           (tenant_id, property_id, channel_code, event_type, dedup_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (
           tenant_id,
           COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid),
           channel_code,
           event_type,
           dedup_key
         )
         DO UPDATE SET
           last_received_at = now(),
           delivery_count   = ota_inbound_event_dedup.delivery_count + 1,
           updated_at       = now()
         RETURNING *, (delivery_count > 1) AS is_duplicate`,
        [tenantId, propertyId || null, channelCode, eventType, dedupKey]
      );
      const row = r.rows[0];
      return { row, isDuplicate: Boolean(row.is_duplicate) };
    },
    // Only transitions from 'received' — preserves already-processed results on duplicate delivery.
    async markProcessed(id, resultRef, client) {
      this._requireClient(client);
      await client.query(
        `UPDATE ota_inbound_event_dedup
            SET processing_status = 'processed',
                processed_at      = now(),
                result_ref        = $2,
                updated_at        = now()
          WHERE id = $1
            AND processing_status = 'received'`,
        [id, resultRef ? String(resultRef).slice(0, 200) : null]
      );
    },
    async markRejected(id, reason, client) {
      this._requireClient(client);
      await client.query(
        `UPDATE ota_inbound_event_dedup
            SET processing_status = 'rejected',
                result_ref        = $2,
                updated_at        = now()
          WHERE id = $1
            AND processing_status NOT IN ('processed','rejected')`,
        [id, reason ? String(reason).slice(0, 200) : null]
      );
    }
  };

  // ---- M1A: gate pass repo (Phase 46B contract, gate_passes table / 0053) ----
  // Mirrors the in-memory fake used by server/test/phase47_api_bridge.test.js
  // and server/test/phase46b_agent_rbac.test.js: list(ctx), create(rec, ctx),
  // recordScan(id, body, ctx). Explicit tenant_id + property_id filtering on
  // every query - RLS (0053) is defense-in-depth, not the sole guard.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const gatepasRepo = {
    async list(ctx) {
      const r = await pool.query(
        `SELECT * FROM gate_passes
          WHERE tenant_id = $1
            AND ($2::uuid IS NULL OR property_id = $2)
          ORDER BY created_at DESC`,
        [ctx.tenantId, ctx.propertyId || null]
      );
      return r.rows;
    },
    async create(rec, ctx) {
      const r = await pool.query(
        `INSERT INTO gate_passes
           (tenant_id, property_id, pass_no, type, name, movement,
            reservation_id, created_by_user_id, purpose, status, valid_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [ctx.tenantId, rec.property_id || null, rec.pass_no, rec.type, rec.name,
         rec.movement, rec.reservation_id || null, rec.created_by_user_id,
         rec.purpose || null, rec.status, rec.valid_from]
      );
      return r.rows[0];
    },
    async recordScan(id, body, ctx) {
      if (!UUID_RE.test(String(id || ''))) return null; // malformed id -> 404, not 500
      const r = await pool.query(
        `UPDATE gate_passes
            SET scans = scans || jsonb_build_array(jsonb_build_object(
                  'ts', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  'dir', $4::text, 'scanned_by', $5::text))
          WHERE tenant_id = $1
            AND ($2::uuid IS NULL OR property_id = $2)
            AND id = $3
          RETURNING *`,
        [ctx.tenantId, ctx.propertyId || null, id, body.direction || 'IN', ctx.actorId]
      );
      return r.rows[0] || null;
    }
  };

  // ---- M1A correction round: shared authorized-property resolution ---------
  //
  // Replaces the earlier "fall back to the tenant's arbitrary first property"
  // behaviour, which let a POS order silently land on a property the caller
  // was never granted access to. Resolution now uses ONLY real authorization
  // data already established by Phase 6/31.5 (identityRepo.listAccessibleProperties
  // / canAccessProperty) - never an unrestricted tenant-wide query:
  //
  //   - ctx.propertyId is already set (identityContext middleware resolved it
  //     from the user's primary_property_id, or validated an X-Property-Id
  //     header via canAccessProperty before ever reaching the route). We
  //     re-verify authorization here too as defense-in-depth rather than
  //     trusting the upstream layer blindly.
  //   - ctx.propertyId is absent: resolve from the user's authorized-property
  //     set. Exactly one authorized property -> auto-resolve to it (safe,
  //     unambiguous). Zero authorized properties -> PROPERTY_ACCESS_DENIED
  //     (403). More than one, with no active context to disambiguate ->
  //     `requiredCode` (400; the caller must set an active property via
  //     X-Property-Id before the mutation/read can proceed).
  //
  // `requiredCode` lets each domain surface a domain-specific 400 code
  // (POS_PROPERTY_REQUIRED / PATROL_PROPERTY_REQUIRED) while sharing one
  // authorization-resolution implementation.
  async function _resolveAuthorizedPropertyId(ctx, requiredCode) {
    if (ctx.propertyId) {
      const ok = await identityRepo.canAccessProperty(ctx.actorId, ctx.propertyId);
      if (!ok) {
        throw Object.assign(
          new Error('user is not authorized for the active property'),
          { code: 'PROPERTY_ACCESS_DENIED' }
        );
      }
      return ctx.propertyId;
    }
    const accessible = await identityRepo.listAccessibleProperties(ctx.actorId);
    if (!accessible || accessible.length === 0) {
      throw Object.assign(
        new Error('user has no authorized property'),
        { code: 'PROPERTY_ACCESS_DENIED' }
      );
    }
    if (accessible.length > 1) {
      throw Object.assign(
        new Error('multiple authorized properties; an active property context is required'),
        { code: requiredCode }
      );
    }
    return accessible[0].id;
  }

  // ---- M1A: POS/KOT order repo (Phase 46B contract, pos_orders table / 0028 + 0054) --
  //
  // The pos_orders table (migration 0028) was built for a separate, fuller
  // restaurant/KOT module: it requires outlet_id (NOT NULL FK), order_number
  // (NOT NULL, UNIQUE per property), and a closed status enum ('OPEN','SENT',
  // 'SERVED','PAID','VOIDED') - none of which the Phase 46B agent-facing
  // pos.js route contract (type/table_ref/items/notes/status:'Pending')
  // collects. Rather than altering that table's constraints (risking the
  // separate restaurant/KOT feature) or forking a new table, this repo:
  //   - stores the route's logical fields (type, table_ref, items, notes,
  //     status) inside the existing `payload` JSONB column and reconstructs
  //     them on read, so the HTTP response shape is byte-for-byte unchanged;
  //   - auto-provisions one idempotent per-property "AGENT" outlet to satisfy
  //     the outlet_id FK, and generates a unique order_number server-side;
  //   - always persists the technical DB `status` as 'OPEN' (a valid enum
  //     value) while the logical/contract status ('Pending') lives in payload.
  // pos_orders.property_id is NOT NULL (unlike gate_passes), so this repo
  // requires a resolved, AUTHORIZED property context - see
  // _resolveAuthorizedPropertyId above - and throws a tagged error
  // (POS_PROPERTY_REQUIRED / PROPERTY_ACCESS_DENIED) otherwise; the route
  // translates those into 400 / 403, not a raw 500.
  function _genOrderNumber() {
    return 'AGT-' + Date.now().toString(36).toUpperCase() + '-' +
      crypto.randomBytes(3).toString('hex').toUpperCase();
  }
  function _reshapePosOrder(row) {
    if (!row) return null;
    let payload = row.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = {}; } }
    payload = payload || {};
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      property_id: row.property_id,
      type: payload.type || 'Room Service',
      table_ref: payload.table_ref != null ? payload.table_ref : null,
      items: Array.isArray(payload.items) ? payload.items : [],
      notes: payload.notes != null ? payload.notes : null,
      status: payload.status || 'Pending',
      created_by_user_id: row.created_by_user_id || null,
      created_at: row.opened_at
    };
  }
  async function _ensureDefaultOutlet(tenantId, propertyId) {
    const code = 'AGENT';
    const ins = await pool.query(
      `INSERT INTO restaurant_outlets (tenant_id, property_id, code, name, kind, active)
       VALUES ($1,$2,$3,'Agent / Room Service Orders','ROOM_SERVICE',true)
       ON CONFLICT (property_id, code) DO NOTHING
       RETURNING id`,
      [tenantId, propertyId, code]
    );
    if (ins.rows[0]) return ins.rows[0].id;
    const sel = await pool.query(
      `SELECT id FROM restaurant_outlets WHERE property_id = $1 AND code = $2 LIMIT 1`,
      [propertyId, code]
    );
    return sel.rows[0].id;
  }

  const posOrderRepo = {
    async list(ctx) {
      const r = await pool.query(
        `SELECT * FROM pos_orders
          WHERE tenant_id = $1
            AND ($2::uuid IS NULL OR property_id = $2)
          ORDER BY opened_at DESC`,
        [ctx.tenantId, ctx.propertyId || null]
      );
      return r.rows.map(_reshapePosOrder);
    },
    async create(rec, ctx) {
      // Property is resolved from the AUTHENTICATED user's authorized-property
      // set only - never from rec.property_id (client input) and never from an
      // unrestricted tenant-wide query. See _resolveAuthorizedPropertyId.
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'POS_PROPERTY_REQUIRED');
      const outletId = await _ensureDefaultOutlet(ctx.tenantId, propertyId);
      const payload = {
        type: rec.type || 'Room Service',
        table_ref: rec.table_ref || null,
        items: rec.items || [],
        notes: rec.notes || null,
        status: rec.status || 'Pending'
      };
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        const orderNumber = _genOrderNumber();
        try {
          const r = await pool.query(
            `INSERT INTO pos_orders
               (tenant_id, property_id, outlet_id, order_number, status,
                created_by_user_id, payload)
             VALUES ($1,$2,$3,$4,'OPEN'::pos_order_status,$5,$6)
             RETURNING *`,
            [ctx.tenantId, propertyId, outletId, orderNumber,
             rec.created_by_user_id, JSON.stringify(payload)]
          );
          return _reshapePosOrder(r.rows[0]);
        } catch (err) {
          lastErr = err;
          if (err && err.code === '23505') continue; // order_number collision - retry
          throw err;
        }
      }
      throw lastErr;
    }
  };

  // ---- M1A: patrol repo (Phase 48 contract, patrol_points/patrol_logs / 0078) --
  //
  // Patrol points and logs are physical-property operational records
  // (M1A correction round): property_id is NOT NULL on both tables (see
  // migration 0078), and every read and mutation resolves and filters by an
  // AUTHORIZED property via _resolveAuthorizedPropertyId - never a
  // client-supplied or unrestricted tenant-wide value.
  const patrolRepo = {
    async listPoints(ctx) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'PATROL_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT * FROM patrol_points
          WHERE tenant_id = $1 AND property_id = $2
          ORDER BY name`,
        [ctx.tenantId, propertyId]
      );
      return r.rows;
    },
    async createPoint(rec, ctx) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'PATROL_PROPERTY_REQUIRED');
      const r = await pool.query(
        `INSERT INTO patrol_points
           (tenant_id, property_id, name, zone, lat, lng, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [ctx.tenantId, propertyId, rec.name, rec.zone,
         rec.lat, rec.lng, rec.active !== false, rec.created_by || null]
      );
      return r.rows[0];
    },
    async togglePoint(id, ctx) {
      if (!UUID_RE.test(String(id || ''))) return null;
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'PATROL_PROPERTY_REQUIRED');
      const r = await pool.query(
        `UPDATE patrol_points
            SET active = NOT active, updated_at = now()
          WHERE tenant_id = $1 AND property_id = $2 AND id = $3
          RETURNING *`,
        [ctx.tenantId, propertyId, id]
      );
      return r.rows[0] || null;
    },
    async listLogs(ctx) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'PATROL_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT * FROM patrol_logs
          WHERE tenant_id = $1 AND property_id = $2
          ORDER BY checked_at DESC`,
        [ctx.tenantId, propertyId]
      );
      return r.rows;
    },
    async createLog(rec, ctx) {
      if (!UUID_RE.test(String(rec.point_id || ''))) {
        throw Object.assign(new Error('patrol point not found'), { code: 'PATROL_POINT_NOT_FOUND' });
      }
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'PATROL_PROPERTY_REQUIRED');
      try {
        // INSERT ... SELECT ... WHERE EXISTS: the referenced point must belong
        // to the SAME tenant AND SAME property as the log being created, in one
        // atomic statement (no separate check-then-insert race). A point that
        // exists but in a different property (or a different tenant, though RLS
        // already makes those invisible) yields zero rows here, same as a
        // point_id that doesn't exist at all - both surface as
        // PATROL_POINT_NOT_FOUND to the caller, never a silent cross-property
        // write.
        const r = await pool.query(
          `INSERT INTO patrol_logs
             (tenant_id, property_id, point_id, officer_id, gps_lat, gps_lng, gps_acc, checked_at)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8
            WHERE EXISTS (
              SELECT 1 FROM patrol_points pp
               WHERE pp.id = $3 AND pp.tenant_id = $1 AND pp.property_id = $2
            )
           RETURNING *`,
          [ctx.tenantId, propertyId, rec.point_id, rec.officer_id,
           rec.gps_lat, rec.gps_lng, rec.gps_acc, rec.checked_at]
        );
        if (!r.rows[0]) {
          throw Object.assign(new Error('patrol point not found'), { code: 'PATROL_POINT_NOT_FOUND' });
        }
        return r.rows[0];
      } catch (err) {
        if (err && err.code === '23503') { // FK violation: point_id does not exist at all
          throw Object.assign(new Error('patrol point not found'), { code: 'PATROL_POINT_NOT_FOUND' });
        }
        throw err;
      }
    }
  };

  // ---- Phase 59: Incident reports repo -----------------------------------
  function _genIncidentNumber() {
    return 'INC-' + Date.now().toString(36).toUpperCase() + '-' +
      crypto.randomBytes(2).toString('hex').toUpperCase();
  }

  const VALID_INCIDENT_STATUSES = new Set(['open','assigned','in_progress','resolved','closed']);
  const VALID_INCIDENT_CATEGORIES = new Set([
    'Security','Accident','Fire','Medical','Theft','Property Damage','Other'
  ]);
  const VALID_INCIDENT_SEVERITIES = new Set(['low','medium','high','critical']);

  const incidentRepo = {
    async list(ctx, { status, limit } = {}) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'INCIDENT_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT * FROM incident_reports
          WHERE tenant_id = $1 AND property_id = $2
            AND ($3::text IS NULL OR status = $3)
          ORDER BY occurred_at DESC
          LIMIT $4`,
        [ctx.tenantId, propertyId, status || null, Math.min(Number(limit) || 100, 500)]
      );
      return r.rows;
    },
    async findById(ctx, id) {
      if (!UUID_RE.test(String(id || ''))) return null;
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'INCIDENT_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT * FROM incident_reports
          WHERE tenant_id = $1 AND property_id = $2 AND id = $3`,
        [ctx.tenantId, propertyId, id]
      );
      return r.rows[0] || null;
    },
    async create(rec, ctx) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'INCIDENT_PROPERTY_REQUIRED');
      const incidentNumber = _genIncidentNumber();
      const r = await pool.query(
        `INSERT INTO incident_reports
           (tenant_id, property_id, incident_number, category, severity,
            title, description, location_text, occurred_at,
            reported_by_user_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')
         RETURNING *`,
        [ctx.tenantId, propertyId, incidentNumber,
         rec.category || 'Other', rec.severity || 'medium',
         rec.title, rec.description || null, rec.location_text || null,
         rec.occurred_at || new Date().toISOString(),
         rec.reported_by_user_id]
      );
      return r.rows[0];
    },
    async updateStatus(id, ctx, { status, assignedToUserId, actionTaken, resolvedAt } = {}) {
      if (!UUID_RE.test(String(id || ''))) return null;
      if (status && !VALID_INCIDENT_STATUSES.has(status)) {
        throw Object.assign(new Error('invalid incident status'), { code: 'INVALID_STATUS' });
      }
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'INCIDENT_PROPERTY_REQUIRED');
      const r = await pool.query(
        `UPDATE incident_reports
            SET status               = COALESCE($4, status),
                assigned_to_user_id = COALESCE($5, assigned_to_user_id),
                action_taken        = COALESCE($6, action_taken),
                resolved_at         = COALESCE($7, resolved_at),
                updated_at          = now()
          WHERE tenant_id = $1 AND property_id = $2 AND id = $3
          RETURNING *`,
        [ctx.tenantId, propertyId, id,
         status || null, assignedToUserId || null,
         actionTaken || null, resolvedAt || null]
      );
      return r.rows[0] || null;
    }
  };

  // ---- Phase 59: Maintenance work orders repo ----------------------------
  function _genWorkOrderNumber() {
    return 'WO-' + Date.now().toString(36).toUpperCase() + '-' +
      crypto.randomBytes(2).toString('hex').toUpperCase();
  }

  const VALID_WO_STATUSES = new Set([
    'open','assigned','in_progress','on_hold','completed','cancelled'
  ]);

  const maintenanceRepo = {
    async list(ctx, { status, limit } = {}) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'MAINTENANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT * FROM maintenance_work_orders
          WHERE tenant_id = $1 AND property_id = $2
            AND ($3::text IS NULL OR status = $3)
          ORDER BY created_at DESC
          LIMIT $4`,
        [ctx.tenantId, propertyId, status || null, Math.min(Number(limit) || 100, 500)]
      );
      return r.rows;
    },
    async findById(ctx, id) {
      if (!UUID_RE.test(String(id || ''))) return null;
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'MAINTENANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT * FROM maintenance_work_orders
          WHERE tenant_id = $1 AND property_id = $2 AND id = $3`,
        [ctx.tenantId, propertyId, id]
      );
      return r.rows[0] || null;
    },
    async create(rec, ctx) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'MAINTENANCE_PROPERTY_REQUIRED');
      const workOrderNumber = _genWorkOrderNumber();
      const r = await pool.query(
        `INSERT INTO maintenance_work_orders
           (tenant_id, property_id, work_order_number, asset_or_location,
            category, priority, title, description,
            reported_by_user_id, status, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10)
         RETURNING *`,
        [ctx.tenantId, propertyId, workOrderNumber,
         rec.asset_or_location || null,
         rec.category || 'General', rec.priority || 'medium',
         rec.title, rec.description || null,
         rec.reported_by_user_id, rec.due_at || null]
      );
      return r.rows[0];
    },
    async assign(id, ctx, { assignedToUserId } = {}) {
      if (!UUID_RE.test(String(id || ''))) return null;
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'MAINTENANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `UPDATE maintenance_work_orders
            SET assigned_to_user_id = $4,
                status              = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
                updated_at          = now()
          WHERE tenant_id = $1 AND property_id = $2 AND id = $3
          RETURNING *`,
        [ctx.tenantId, propertyId, id, assignedToUserId]
      );
      return r.rows[0] || null;
    },
    async updateStatus(id, ctx, { status, resolutionNotes } = {}) {
      if (!UUID_RE.test(String(id || ''))) return null;
      if (status && !VALID_WO_STATUSES.has(status)) {
        throw Object.assign(new Error('invalid work order status'), { code: 'INVALID_STATUS' });
      }
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'MAINTENANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `UPDATE maintenance_work_orders
            SET status           = COALESCE($4, status),
                started_at       = CASE WHEN $4 = 'in_progress' AND started_at IS NULL
                                        THEN now() ELSE started_at END,
                completed_at     = CASE WHEN $4 = 'completed' AND completed_at IS NULL
                                        THEN now() ELSE completed_at END,
                resolution_notes = COALESCE($5, resolution_notes),
                updated_at       = now()
          WHERE tenant_id = $1 AND property_id = $2 AND id = $3
          RETURNING *`,
        [ctx.tenantId, propertyId, id, status || null, resolutionNotes || null]
      );
      return r.rows[0] || null;
    },
    async complete(id, ctx, { resolutionNotes } = {}) {
      if (!UUID_RE.test(String(id || ''))) return null;
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'MAINTENANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `UPDATE maintenance_work_orders
            SET status           = 'completed',
                completed_at     = COALESCE(completed_at, now()),
                resolution_notes = COALESCE($4, resolution_notes),
                updated_at       = now()
          WHERE tenant_id = $1 AND property_id = $2 AND id = $3
            AND status NOT IN ('completed','cancelled')
          RETURNING *`,
        [ctx.tenantId, propertyId, id, resolutionNotes || null]
      );
      return r.rows[0] || null;
    }
  };

  // ---- Phase 59: Attendance events repo ----------------------------------
  // Event-based only: check_in / check_out. No continuous tracking.
  // GPS coordinates are optional; validated at the DB constraint level.
  const VALID_ATTENDANCE_SOURCES = new Set(['manual','gate','patrol','mobile_event']);
  const VALID_ATTENDANCE_EVENT_TYPES = new Set(['check_in','check_out']);

  const attendanceRepo = {
    async getOpenCheckIn(ctx, userId) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'ATTENDANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT ae.*
           FROM attendance_events ae
          WHERE ae.tenant_id = $1
            AND ae.property_id = $2
            AND ae.user_id = $3
            AND ae.event_type = 'check_in'
            AND NOT EXISTS (
              SELECT 1 FROM attendance_events co
               WHERE co.tenant_id = ae.tenant_id
                 AND co.property_id = ae.property_id
                 AND co.user_id = ae.user_id
                 AND co.event_type = 'check_out'
                 AND co.event_at > ae.event_at
            )
          ORDER BY ae.event_at DESC
          LIMIT 1`,
        [ctx.tenantId, propertyId, userId]
      );
      return r.rows[0] || null;
    },
    async recordEvent(rec, ctx) {
      if (!VALID_ATTENDANCE_EVENT_TYPES.has(rec.event_type)) {
        throw Object.assign(new Error('invalid event_type'), { code: 'INVALID_EVENT_TYPE' });
      }
      if (rec.source && !VALID_ATTENDANCE_SOURCES.has(rec.source)) {
        throw Object.assign(new Error('invalid source'), { code: 'INVALID_SOURCE' });
      }
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'ATTENDANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `INSERT INTO attendance_events
           (tenant_id, property_id, user_id, event_type, event_at,
            source, latitude, longitude, accuracy_meters,
            patrol_point_id, gate_reference, device_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [ctx.tenantId, propertyId, rec.user_id, rec.event_type,
         rec.event_at || new Date().toISOString(),
         rec.source || 'manual',
         rec.latitude  != null ? rec.latitude  : null,
         rec.longitude != null ? rec.longitude : null,
         rec.accuracy_meters != null ? rec.accuracy_meters : null,
         UUID_RE.test(String(rec.patrol_point_id || '')) ? rec.patrol_point_id : null,
         rec.gate_reference   || null,
         rec.device_reference || null]
      );
      return r.rows[0];
    },
    async listMyEvents(ctx, { limit } = {}) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'ATTENDANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT * FROM attendance_events
          WHERE tenant_id = $1 AND property_id = $2 AND user_id = $3
          ORDER BY event_at DESC
          LIMIT $4`,
        [ctx.tenantId, propertyId, ctx.actorId, Math.min(Number(limit) || 50, 200)]
      );
      return r.rows;
    },
    async listAllEvents(ctx, { userId, dateFrom, dateTo, limit } = {}) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'ATTENDANCE_PROPERTY_REQUIRED');
      const r = await pool.query(
        `SELECT * FROM attendance_events
          WHERE tenant_id = $1 AND property_id = $2
            AND ($3::uuid IS NULL OR user_id = $3)
            AND ($4::timestamptz IS NULL OR event_at >= $4)
            AND ($5::timestamptz IS NULL OR event_at <= $5)
          ORDER BY event_at DESC
          LIMIT $6`,
        [ctx.tenantId, propertyId,
         UUID_RE.test(String(userId || '')) ? userId : null,
         dateFrom || null, dateTo || null,
         Math.min(Number(limit) || 100, 500)]
      );
      return r.rows;
    },

    // Returns authoritative attendance status for the calling user.
    // No coordinates are returned. Status is computed server-side only.
    async getStatus(ctx) {
      const propertyId = await _resolveAuthorizedPropertyId(ctx, 'ATTENDANCE_PROPERTY_REQUIRED');
      const latestR = await pool.query(
        `SELECT id, event_type, event_at, source
           FROM attendance_events
          WHERE tenant_id = $1 AND property_id = $2 AND user_id = $3
          ORDER BY event_at DESC LIMIT 1`,
        [ctx.tenantId, propertyId, ctx.actorId]
      );
      const latest = latestR.rows[0] || null;

      const openR = await pool.query(
        `SELECT ae.id, ae.event_at, ae.source
           FROM attendance_events ae
          WHERE ae.tenant_id = $1
            AND ae.property_id = $2
            AND ae.user_id = $3
            AND ae.event_type = 'check_in'
            AND NOT EXISTS (
              SELECT 1 FROM attendance_events co
               WHERE co.tenant_id = ae.tenant_id
                 AND co.property_id = ae.property_id
                 AND co.user_id = ae.user_id
                 AND co.event_type = 'check_out'
                 AND co.event_at > ae.event_at
            )
          ORDER BY ae.event_at DESC LIMIT 1`,
        [ctx.tenantId, propertyId, ctx.actorId]
      );
      const openCheckIn = openR.rows[0] || null;

      const status = !latest ? 'no_events' : openCheckIn ? 'checked_in' : 'checked_out';
      return {
        status,
        open_check_in: openCheckIn
          ? { id: openCheckIn.id, event_at: openCheckIn.event_at, source: openCheckIn.source }
          : null,
        latest_event: latest
          ? { id: latest.id, event_type: latest.event_type,
              event_at: latest.event_at, source: latest.source }
          : null
      };
    }
  };

  return {
    identityRepo, tokensRepo,
    settingsRepo, fileRepo, connectorRepo, schedulerRepo, notificationRepo,
    confirmationDeliveryRepo, webhookRepo,
    aggregateRepo, pmsRepo,
    folioRepo, housekeepingRepo, nightAuditRepo,
    costCenterRepo, revenueMapRepo, ledgerRepo,
    invitationRepo, passwordResetRepo,
    otaInboundEventDedupRepo,
    gatepasRepo, posOrderRepo, patrolRepo,
    incidentRepo, maintenanceRepo, attendanceRepo
  };
}

module.exports = { buildRepos };
