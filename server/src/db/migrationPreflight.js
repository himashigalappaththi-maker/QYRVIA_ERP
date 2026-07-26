'use strict';

/**
 * Phase 63 P0-2 — boot-time migration preflight.
 *
 * PROBLEM THIS FIXES
 * ──────────────────
 * `server/src/index.js` had no migration-state logic at all. A process started
 * against a database that is missing the latest migrations booted cleanly and
 * answered `/health/ready` with `{db:"ok"}` — because that probe only pings the
 * connection, it says nothing about the schema version. The orchestrator then
 * marks the instance healthy and routes real multi-tenant reservation and
 * financial traffic at a stale schema.
 *
 * The only existing drift check lived in `server/scripts/prod-preflight.js`,
 * an out-of-band script that nothing invokes.
 *
 * BEHAVIOUR
 * ─────────
 *   production  : pending migrations => hard failure (caller exits non-zero).
 *                 The container never becomes healthy. This is the point.
 *   non-production: pending migrations => loud warning, boot continues, so
 *                 local development and the test suite are unaffected.
 *
 * The check is read-only: it never applies a migration and never writes.
 * It is also fail-safe in the sense that it can only ever REFUSE to boot — it
 * cannot mutate the database.
 */

const fs   = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Migration file names, lexically ordered (the runner's ordering contract). */
function listMigrationVersions(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => f.replace(/\.sql$/, ''));
}

/**
 * Compare on-disk migrations against `schema_migrations`.
 *
 * @param {{query: Function}} queryable  pg Pool/Client (or a stub in tests)
 * @param {{dir?: string}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, pending:string[], unknown:string[], applied:number, total:number}>}
 */
async function inspectMigrationState(queryable, opts = {}) {
  const expected = listMigrationVersions(opts.dir || MIGRATIONS_DIR);

  let appliedRows;
  try {
    const r = await queryable.query('SELECT version FROM schema_migrations ORDER BY version');
    appliedRows = r && r.rows ? r.rows.map((row) => row.version) : [];
  } catch (err) {
    // A missing schema_migrations table means the database was never migrated
    // at all. That is the most severe form of drift, not a reason to shrug.
    return {
      ok: false,
      reason: 'schema_migrations_unreadable',
      detail: String((err && err.message) || err),
      pending: expected,
      unknown: [],
      applied: 0,
      total: expected.length
    };
  }

  const appliedSet = new Set(appliedRows);
  const pending = expected.filter((v) => !appliedSet.has(v));
  // Versions recorded in the database that this build does not ship: the
  // deployed artifact is OLDER than the schema (a rollback landed on a
  // forward-migrated database). Equally unsafe.
  const expectedSet = new Set(expected);
  const unknown = appliedRows.filter((v) => !expectedSet.has(v));

  if (pending.length > 0) {
    return { ok: false, reason: 'pending_migrations', pending, unknown, applied: appliedRows.length, total: expected.length };
  }
  if (unknown.length > 0) {
    return { ok: false, reason: 'schema_ahead_of_build', pending, unknown, applied: appliedRows.length, total: expected.length };
  }
  return { ok: true, pending: [], unknown: [], applied: appliedRows.length, total: expected.length };
}

/**
 * Run the preflight and decide what boot should do.
 *
 * @returns {Promise<{fatal:boolean, state:object}>} `fatal:true` means the
 *          caller MUST abort boot (production drift).
 */
async function runMigrationPreflight({ queryable, isProduction, logger, dir } = {}) {
  const log = logger || { info() {}, warn() {}, error() {} };

  if (!queryable || typeof queryable.query !== 'function') {
    // No DB handle to check with. In production that is itself fatal — we must
    // not boot without being able to prove the schema.
    const state = { ok: false, reason: 'no_database_handle', pending: [], unknown: [], applied: 0, total: 0 };
    if (isProduction) log.error({ code: 'migration_preflight_failed', ...state }, '[preflight] cannot verify schema version');
    return { fatal: Boolean(isProduction), state };
  }

  const state = await inspectMigrationState(queryable, { dir });

  if (state.ok) {
    log.info({ applied: state.applied, total: state.total }, '[preflight] schema is up to date');
    return { fatal: false, state };
  }

  const detail = {
    code: 'migration_preflight_failed',
    reason: state.reason,
    pending: state.pending,
    unknown: state.unknown,
    applied: state.applied,
    total: state.total
  };

  if (isProduction) {
    log.error(detail, '[preflight] REFUSING TO BOOT - database schema does not match this build');
    return { fatal: true, state };
  }

  log.warn(detail, '[preflight] schema drift detected (non-production: continuing)');
  return { fatal: false, state };
}

module.exports = { listMigrationVersions, inspectMigrationState, runMigrationPreflight, MIGRATIONS_DIR };
