'use strict';

/**
 * Phase 9.1 - Real PostgreSQL integration test harness.
 *
 * These helpers power the DB-backed test mode. They are a *separate* layer
 * from the in-memory unit fixtures (`test/_fixtures.js`); unit mode is left
 * untouched.
 *
 * Activation: a DB connection string in `TEST_DATABASE_URL` (preferred) or
 * `DATABASE_URL`. When neither is present, `dbConfig()` returns null and every
 * `*.db.test.js` file registers a single skipped placeholder and returns - so
 * a plain `npm test` on a machine without Postgres stays green.
 *
 * Isolation model: `freshSchema(pool)` drops and recreates the `public`
 * schema, then applies migrations 0001..NNNN in strict lexical order using the
 * same tracking table (`schema_migrations`) the production runner uses. Every
 * DB test file calls this once in a `before()` hook so it runs against a clean
 * database.
 */

const fs   = require('node:fs');
const path = require('node:path');

let Pool;
try { ({ Pool } = require('pg')); } catch (_) { Pool = null; }

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');

/** Returns the test DB connection string, or null when DB mode is off. */
function dbConfig() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL_TEST;
  // Guard against the unit-test sentinel from _fixtures.js (a fake localhost
  // URL that points at no real server). DB mode requires an explicit opt-in.
  if (!url) return null;
  if (!Pool) return null;
  return url;
}

function newPool(connectionString, overrides = {}) {
  return new Pool(Object.assign({
    connectionString, max: 5, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000
  }, overrides));
}

function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

/**
 * Drop & recreate the public schema, then apply every migration in order.
 * Returns { applied: [{version, ms}], total } for the verification report.
 * Throws on the FIRST failing migration (ordering / drift / SQL error) so CI
 * fails immediately, per the Phase 9.1 brief.
 */
async function freshSchema(pool) {
  // Clean slate. CASCADE removes tables, types (enums), policies, functions.
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
  await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC');

  const files = listMigrationFiles();
  const applied = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const version = f.replace(/\.sql$/, '');
    const client = await pool.connect();
    const t0 = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      err.message = '[migration ' + f + '] ' + err.message;
      throw err;
    } finally {
      client.release();
    }
    applied.push({ version, ms: Date.now() - t0 });
  }
  return { applied, total: files.length };
}

/**
 * Create (or reset) a NON-privileged login role used to prove RLS. It is
 * NOSUPERUSER + NOBYPASSRLS, so RLS policies actually bind to it (a superuser
 * silently bypasses RLS - which is why the production app, connecting as the
 * DB owner, does not have RLS enforced; see the verification report).
 *
 * Deliberately granted only SELECT + INSERT so the append-only posture
 * (REVOKE UPDATE,DELETE) is observable as a privilege denial.
 */
async function setupAppRole(pool, { role = 'qyrvia_app_rls', password = 'rls_test_pw' } = {}) {
  await pool.query(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await pool.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO ${role}`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  return { role, password };
}

/** Build a role-scoped connection string from the admin URL. */
function roleUrl(adminUrl, role, password) {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  return u.toString();
}

/**
 * Run `fn(client)` inside a transaction with `app.tenant_id` set - the exact
 * RLS context the production `db/client.js withTenant()` establishes.
 */
async function withTenant(pool, tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId == null ? '' : tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

/** A db facade compatible with eventBus.init({ db }) that writes to real tables. */
function realDbFacade(pool) {
  return {
    async ping() { const r = await pool.query('SELECT 1 ok'); return r.rows[0].ok === 1; },
    async insertAuditEvent(ev) {
      await pool.query(
        `INSERT INTO audit_events (event_id, event_type, aggregate_type, aggregate_id,
            tenant_id, property_id, actor_id, request_id, payload, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ev.event_id, ev.event_type, ev.aggregate_type, ev.aggregate_id, ev.tenant_id,
         ev.property_id, ev.actor_id, ev.request_id, ev.payload, ev.occurred_at]);
    },
    async insertDomainEvent(ev) {
      await pool.query(
        `INSERT INTO event_store (id, tenant_id, property_id, aggregate_type, aggregate_id,
            event_type, event_version, payload_json, actor_id, request_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [ev.event_id, ev.tenant_id, ev.property_id, ev.aggregate_type, ev.aggregate_id,
         ev.event_type, 1, ev.payload, ev.actor_id, ev.request_id, ev.occurred_at]);
    }
  };
}

/** Seed a tenant + property and return their ids (admin/superuser pool). */
async function seedTenantProperty(pool, { code = 'T1', propCode = 'P1' } = {}) {
  const t = await pool.query(
    `INSERT INTO tenants (code, name) VALUES ($1,$2) RETURNING id`, [code, code + ' Co']);
  const tenantId = t.rows[0].id;
  const p = await pool.query(
    `INSERT INTO properties (tenant_id, code, name, currency) VALUES ($1,$2,$3,'LKR') RETURNING id`,
    [tenantId, propCode, propCode + ' Hotel']);
  return { tenantId, propertyId: p.rows[0].id };
}

/** True if the thrown pg error matches a SQLSTATE class we expect. */
function isPgError(err, codePrefix) {
  return !!(err && err.code && String(err.code).startsWith(codePrefix));
}

module.exports = {
  dbConfig, newPool, freshSchema, setupAppRole, roleUrl, withTenant,
  realDbFacade, seedTenantProperty, listMigrationFiles, isPgError
};
