'use strict';

const { Pool } = require('pg');
const env      = require('../config/env');
const logger   = require('../config/logger');
const { getObservability } = require('../observability');
const { instrumentClient } = require('../observability/instrumentedPool');

/**
 * PostgreSQL connection pool. Shared across the process.
 *
 * IMPORTANT: tenant-scoped queries must go through `withTenant(tenantId, cb)`
 * which issues `SET LOCAL app.tenant_id = '<uuid>'` inside a transaction.
 * Phase 1 enables RLS on tenants/properties/audit_events but adds no policies
 * yet (policies arrive in Phase 3 - Auth). The application contract is
 * already correct so when policies land no application code changes.
 */

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle pg client errored');
});

/**
 * Run a callback with a tenant-scoped client. Opens a transaction, sets
 * `app.tenant_id`, runs the callback with the client, commits (or rolls
 * back on throw), releases.
 *
 * Usage:
 *   const rows = await withTenant(ctx.tenantId, async (client) => {
 *     const r = await client.query('SELECT * FROM properties');
 *     return r.rows;
 *   });
 *
 * @param {string} tenantId  - UUID string (required; throws if missing).
 * @param {(client) => Promise<T>} cb
 * @returns {Promise<T>}
 */
async function withTenant(tenantId, cb) {
  if (!tenantId) {
    // Phase 32: a tenant-scoped operation reached the DB without a tenant in
    // context. Count + log it as a security-relevant RLS context failure, then
    // fail closed exactly as before.
    try { getObservability().rls.missingContext('tenant'); } catch (_) { /* never block on telemetry */ }
    throw new Error('withTenant: tenantId is required');
  }
  if (typeof cb !== 'function') throw new Error('withTenant: cb must be a function');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(name, value, is_local=true) is parameter-safe; SET LOCAL is not.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    // Phase 32: successful RLS context bind (no ids logged - just the counter).
    try { getObservability().rls.contextSet('tenant'); } catch (_) { /* never block on telemetry */ }
    // Phase 33: instrument the transaction client so the repo queries that run
    // inside this scope record per-query latency (BEGIN/set_config/COMMIT above
    // stay on the raw client and are deliberately not counted as data queries).
    // SQL text/params are never logged - only a hash on the slow path.
    let scopedClient = client;
    if (env.DB_OBSERVABILITY !== 'false') {
      try { scopedClient = instrumentClient(client, getObservability()); } catch (_) { scopedClient = client; }
    }
    const result = await cb(scopedClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Health probe used by /api/health/ready. */
async function ping() {
  const r = await pool.query('SELECT 1 AS ok');
  return r.rows[0] && r.rows[0].ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = { pool, withTenant, ping, close };
